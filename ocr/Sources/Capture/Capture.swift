// yomi — capture ONLY the target window, OCR Japanese text, emit plain text.
//
// Scoping guarantee: the capture filter is constructed from a single SCWindow
// belonging to the target process. There is no code path that captures the
// display, another app, or the desktop. If no target window is found the tool
// exits non-zero rather than falling back to anything broader.

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Turning a chosen window into pixels plus truthful geometry.
// ARCHITECTURE section 1 lives here.

enum CaptureError: Error, CustomStringConvertible {
    case timedOut(Double)
    case discoveryTimedOut(Double)
    case noDisplay
    var description: String {
        switch self {
        case .timedOut(let s):
            return "capture timed out after \(s)s — this happens when the target is in "
                + "native fullscreen on another Space. Exit fullscreen (green button / "
                + "ctrl-cmd-F) and retry."
        case .discoveryTimedOut(let s):
            return "window discovery (SCShareableContent) stalled for \(s)s"
        case .noDisplay:
            return "no display contains the target window"
        }
    }
}

/// A captured frame together with the screen region it actually covers.
///
/// The two are not interchangeable. Only the preferred filter yields an image
/// that is exactly the target window; both fallbacks resolve through the
/// display and hand back a display-sized image with the window drawn somewhere
/// inside it. Recognised coordinates are normalised against *the image*, so
/// anything that converts them without knowing which of the two happened places
/// every glyph box wrong — squashed by the height ratio and shifted by the
/// window's origin.
struct Capture {
    let image: CGImage
    /// Rect the image's normalised coordinates scale against: the display.
    let region: CGRect
    /// Where in the image the window was drawn, in points — measured, see
    /// `contentRect`. Almost always the image origin.
    let inset: CGPoint
    /// Where that window truly is on screen — the origin the consumer adds
    /// back. Not always `SCWindow.frame.origin`: see `trueOrigin(...)`.
    let origin: CGPoint
    /// The window's true size, measured from the capture rather than trusted.
    let size: CGSize

    /// Image coordinates to window-LOCAL ones: scale against the display,
    /// then subtract where the window was drawn.
    var geometry: Geometry {
        Geometry(region: region, window: region.offsetBy(dx: inset.x, dy: inset.y))
    }
}

/// Where the window is in a capture, in points, measured from its pixels.
///
/// With every other window excluded, only the target's pixels are opaque and
/// the rest is fully transparent — and premultiplied-transparent pixels are
/// all-zero whatever the channel order, so "any non-zero byte" identifies
/// content without having to decode the pixel layout.
///
/// The size is the window's TRUE size even when the window server is still
/// reporting its pre-fullscreen frame, which is the whole point: measured on a
/// fullscreen Chrome, `screencapture -l` returned 1440x900 while both
/// CGWindowList and SCWindow.frame insisted on 1440x778 at y=122.
///
/// The origin is where ScreenCaptureKit drew the window, which is the image
/// origin almost always and not always: measured 2026-09-24, a window 90pt
/// below the top of a second display came back drawn at (0,89) on the first
/// capture after the display appeared — and a layer mapped as if it sat at
/// (0,0) put every glyph 89pt low.
func contentRect(_ image: CGImage, scale: CGFloat) -> CGRect? {
    guard let data = image.dataProvider?.data as Data?, scale > 0 else { return nil }
    let bpr = image.bytesPerRow
    let bpp = max(1, image.bitsPerPixel / 8)
    guard bpp >= 4 else { return nil }
    let (w, h) = (image.width, image.height)
    return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> CGRect? in
        func opaque(_ x: Int, _ y: Int) -> Bool {
            let i = y * bpr + x * bpp
            guard i + 3 < raw.count else { return false }
            return raw[i] != 0 || raw[i + 1] != 0 || raw[i + 2] != 0 || raw[i + 3] != 0
        }
        var (minX, minY, maxX, maxY) = (Int.max, Int.max, -1, -1)
        let step = 8  // coarse: a few thousand samples, not eleven million
        for y in stride(from: 0, to: h, by: step) {
            for x in stride(from: 0, to: w, by: step) where opaque(x, y) {
                minX = min(minX, x)
                minY = min(minY, y)
                maxX = max(maxX, x)
                maxY = max(maxY, y)
            }
        }
        guard maxX > 0, maxY > 0 else { return nil }
        // The grid can miss up to `step` pixels at each edge. The trailing
        // edges get that as slack; the leading ones decide where every glyph
        // lands, so they are walked back to the first opaque pixel exactly.
        let columns = Array(stride(from: minX, through: maxX, by: step))
        let rows = Array(stride(from: minY, through: maxY, by: step))
        while minY > 0, columns.contains(where: { opaque($0, minY - 1) }) { minY -= 1 }
        while minX > 0, rows.contains(where: { opaque(minX - 1, $0) }) { minX -= 1 }
        return CGRect(
            x: CGFloat(minX) / scale, y: CGFloat(minY) / scale,
            width: CGFloat(min(maxX + step, w) - minX) / scale,
            height: CGFloat(min(maxY + step, h) - minY) / scale)
    }
}

/// How long a ScreenCaptureKit call may take before the pass gives up on it.
/// Both capture and discovery can stall outright: a fullscreen window on
/// another Space wedges the screenshot, and discovery once went silent for 40
/// minutes (/tmp/yomi-overlay.log 2026-08-09 20:14→20:54).
let sckDeadline: Double = 12

/// `work`'s result, or `timedOut` thrown once `seconds` have passed —
/// whichever comes first.
///
/// Not a task group, which is what both deadlines were: a group cannot finish
/// while a child still runs, and ScreenCaptureKit's completion-handler calls
/// ignore cancellation, so a stalled call held its "deadline" with it. Measured
/// with a call that ignores cancellation: a 0.5 s deadline over 3 s of work
/// threw at 3.20 s that way, at 0.51 s this way. The stalled call is
/// abandoned, as LiveText.analyze abandons a request its watchdog timed out.
func withDeadline<T>(
    _ seconds: Double, orThrow timedOut: Error,
    _ work: @escaping () async throws -> T
) async throws -> T {
    let once = ResumeOnce()
    return try await withCheckedThrowingContinuation { cont in
        let deadline = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if once.claim() { cont.resume(throwing: timedOut) }
        }
        Task {
            do {
                let value = try await work()
                if once.claim() { cont.resume(returning: value) }
            } catch {
                if once.claim() { cont.resume(throwing: error) }
            }
            deadline.cancel()
        }
    }
}

/// Lets exactly one of two racers resume a continuation.
final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// The capture, raced against `sckDeadline`, so a stalled screenshot fails
/// the pass instead of wedging the watch loop.
func capture(_ target: TargetWindow, timeout: Double = sckDeadline) async throws -> Capture {
    try await withDeadline(timeout, orThrow: CaptureError.timedOut(timeout)) {
        try await captureOnce(target: target)
    }
}

private func shoot(_ filter: SCContentFilter) async throws -> CGImage {
    let config = SCStreamConfiguration()
    // Take the backing scale from the filter, not NSScreen — touching AppKit's
    // display connection from a CLI tool with no NSApplication trips
    // CGS_REQUIRE_INIT and aborts.
    let scale = CGFloat(filter.pointPixelScale)
    config.width = Int(filter.contentRect.width * scale)
    config.height = Int(filter.contentRect.height * scale)
    config.showsCursor = false
    config.captureResolution = .best
    return try await SCScreenshotManager.captureImage(
        contentFilter: filter, configuration: config)
}

/// The window's true on-screen origin.
///
/// The reported origin is right for an ordinary window and wrong for a
/// fullscreen one — macOS keeps reporting the pre-fullscreen rect. When the
/// measured content covers a whole display, the window is that display's
/// fullscreen occupant and its origin is the display's.
func trueOrigin(frame: CGRect, measured: CGSize?, display: SCDisplay) -> CGPoint {
    guard let m = measured else { return frame.origin }
    if abs(m.width - display.frame.width) <= 4, abs(m.height - display.frame.height) <= 4 {
        return display.frame.origin
    }
    return frame.origin
}

func captureOnce(target: TargetWindow) async throws -> Capture {
    let window = target.window
    // Display-scoped, with every other window excluded — still only the
    // target's pixels, by construction.
    //
    // Two measured facts drive this shape:
    //
    //   1. The remaining window is composited 1:1 inside a display-sized
    //      image, at the image origin as a rule (a window at (300,200) put its
    //      top-left glyph at (0,0)) — but where is measured, not assumed; see
    //      contentRect. Normalising against the display rect and subtracting
    //      that yields window-LOCAL coordinates, undistorted.
    //   2. A window-scoped filter instead scales the content into the window's
    //      REPORTED rect, which macOS leaves stale after a window goes
    //      fullscreen (Chrome: really 1440x900, reported 1440x778 at y=122).
    //      That squashes every glyph — the ~122pt error at the top of the
    //      window, tapering to zero at the bottom, that made fullscreen unusable.
    //
    // Since (1) is undistorted, only the window's true ORIGIN is still needed,
    // and that is recovered by measuring the captured content — see trueOrigin.
    // The enumeration the caller already paid for, not a second one. It used
    // to be re-fetched here, so every pass cost two ~150 ms discoveries to
    // learn the same thing twice.
    let content = target.content
    let frame = target.frame
    guard
        let display = content.displays.first(where: { $0.frame.intersects(frame) })
            ?? content.displays.first
    else {
        throw CaptureError.noDisplay
    }

    func finish(_ image: CGImage, scale: CGFloat, display: SCDisplay) -> Capture {
        let measured = contentRect(image, scale: scale)
        return Capture(
            image: image,
            region: display.frame,
            inset: measured?.origin ?? .zero,
            origin: trueOrigin(frame: frame, measured: measured?.size, display: display),
            size: measured?.size ?? frame.size)
    }

    do {
        let others = content.windows.filter { $0.windowID != window.windowID }
        let filter = SCContentFilter(display: display, excludingWindows: others)
        return finish(
            try await shoot(filter), scale: CGFloat(filter.pointPixelScale),
            display: display)
    } catch {
        // Some fullscreen Spaces refuse the display filter (-3811). Including
        // just this window behaves the same way for coordinates: content at the
        // image origin, scaled against the display.
        //
        // Re-enumerate first. This filter resolves geometry through the
        // SCWindow handle itself, and the handle may have come from the cache
        // — a stale rect here is exactly the section-1 failure (content scaled
        // into a frame the window no longer has).
        let fresh = try await refreshedContent()
        let w = fresh.windows.first { $0.windowID == window.windowID } ?? window
        let d =
            fresh.displays.first(where: { $0.frame.intersects(frame) })
            ?? fresh.displays.first ?? display
        let filter = SCContentFilter(display: d, including: [w])
        return finish(
            try await shoot(filter), scale: CGFloat(filter.pointPixelScale),
            display: d)
    }
}

/// Hash of every pixel of a captured frame.
///
/// Vision is by far the most expensive step, and a reader spends most of its
/// time on an unchanged page. Skipping recognition when nothing moved both
/// cuts cost and — more importantly — stops the overlay rebuilding its glyph
/// layer under the user's cursor when the content is identical.
///
/// Every byte, not a sample: it hashed every (size/4096)th byte, and a glyph
/// changing between two samples went unseen — 9 of 40 one-glyph changes on a
/// 2880x1800 frame, 20 of 40 with padded rows (measured) — after which the
/// layer described the old page until something bigger changed; voting
/// re-reads only the page it already has. The whole frame costs 3.9 ms a pass
/// against 0.7 ms for the sample (measured, same frame), next to a
/// recognition of 0.6-1.2 s.
func frameHash(_ image: CGImage) -> UInt64 {
    guard let data = image.dataProvider?.data as Data? else { return 0 }
    let bpr = image.bytesPerRow
    let rowBytes = min(bpr, image.width * max(1, image.bitsPerPixel / 8))
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else { return }
        for y in 0..<image.height {
            // The pixels only: nothing promises a row's padding is initialised.
            let start = y * bpr
            let end = min(start + rowBytes, raw.count)
            var i = start
            while i + 8 <= end {
                let word = base.loadUnaligned(fromByteOffset: i, as: UInt64.self)
                h = (h ^ word) &* 0x100_0000_01b3
                i += 8
            }
            while i < end {
                h = (h ^ UInt64(base.load(fromByteOffset: i, as: UInt8.self))) &* 0x100_0000_01b3
                i += 1
            }
        }
    }
    return h
}
