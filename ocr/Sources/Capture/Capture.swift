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
    /// Rect the image's normalised coordinates scale against. The window is
    /// composited at the image ORIGIN (verified by dumping a capture of a
    /// window at 300,200: its top-left glyph landed at 0,0), so normalising
    /// against this yields window-LOCAL coordinates.
    let region: CGRect
    /// Where that window truly is on screen — the origin the consumer adds
    /// back. Not always `SCWindow.frame.origin`: see `trueOrigin(...)`.
    let origin: CGPoint
    /// The window's true size, measured from the capture rather than trusted.
    let size: CGSize
}

/// Extent of non-transparent content in a capture, in points.
///
/// With every other window excluded, only the target's pixels are opaque and
/// the rest is fully transparent — and premultiplied-transparent pixels are
/// all-zero whatever the channel order, so "any non-zero byte" identifies
/// content without having to decode the pixel layout.
///
/// This is the window's TRUE size even when the window server is still
/// reporting its pre-fullscreen frame, which is the whole point: measured on a
/// fullscreen Chrome, `screencapture -l` returned 1440x900 while both
/// CGWindowList and SCWindow.frame insisted on 1440x778 at y=122.
func contentExtent(_ image: CGImage, scale: CGFloat) -> CGSize? {
    guard let data = image.dataProvider?.data as Data?, scale > 0 else { return nil }
    let bpr = image.bytesPerRow
    let bpp = max(1, image.bitsPerPixel / 8)
    guard bpp >= 4 else { return nil }

    var maxX = 0
    var maxY = 0
    let step = 8  // coarse: a few thousand samples, not eleven million
    for y in stride(from: 0, to: image.height, by: step) {
        let row = y * bpr
        for x in stride(from: 0, to: image.width, by: step) {
            let i = row + x * bpp
            guard i + 3 < data.count else { continue }
            if data[i] != 0 || data[i + 1] != 0 || data[i + 2] != 0 || data[i + 3] != 0 {
                if x > maxX { maxX = x }
                if y > maxY { maxY = y }
            }
        }
    }
    guard maxX > 0, maxY > 0 else { return nil }
    // The sample grid can miss up to `step` pixels of the trailing edge.
    return CGSize(
        width: CGFloat(min(maxX + step, image.width)) / scale,
        height: CGFloat(min(maxY + step, image.height)) / scale)
}

/// Races the capture against a deadline. SCScreenshotManager can stall
/// indefinitely on a fullscreen window belonging to another Space, which would
/// otherwise wedge the whole watch loop.
func capture(_ target: TargetWindow, timeout: Double = 12) async throws -> Capture {
    return try await withThrowingTaskGroup(of: Capture.self) { group in
        group.addTask { try await captureOnce(target: target) }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            throw CaptureError.timedOut(timeout)
        }
        guard let first = try await group.next() else {
            throw CaptureError.timedOut(timeout)
        }
        group.cancelAll()
        return first
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
    //   1. The remaining window is composited at the image ORIGIN, 1:1, inside
    //      a display-sized image. Dumping a capture of a window at (300,200)
    //      put its top-left glyph at (0,0). So normalising against the display
    //      rect yields window-LOCAL coordinates, undistorted.
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
        let measured = contentExtent(image, scale: scale)
        return Capture(
            image: image,
            region: display.frame,
            origin: trueOrigin(frame: frame, measured: measured, display: display),
            size: measured ?? frame.size)
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

/// Cheap perceptual hash of a captured frame.
///
/// Vision is by far the most expensive step, and a reader spends most of its
/// time on an unchanged page. Sampling ~4k bytes and comparing lets us skip
/// recognition entirely when nothing moved, which both cuts cost and — more
/// importantly — stops the overlay rebuilding its glyph layer under the user's
/// cursor when the content is identical.
func frameHash(_ image: CGImage) -> UInt64 {
    guard let data = image.dataProvider?.data as Data? else { return 0 }
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    let step = max(1, data.count / 4096)
    var i = 0
    while i < data.count {
        h = (h ^ UInt64(data[i])) &* 0x100_0000_01b3
        i += step
    }
    return h
}
