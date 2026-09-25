// Which window the user is actually looking at, and how much of it they
// can see. ARCHITECTURE section 2 and 3 live here.

import CoreGraphics
import Foundation
import ScreenCaptureKit

// Default target when none is specified. Any window can be targeted instead —
// BOOK☆WALKER in a browser, a manga reader, a PDF viewer — via --bundle/--window.
let defaultBundleIDs: Set<String> = ["com.amazon.Lassen", "com.amazon.Kindle"]

/// What the capture is pinned to. A specific window ID is exact (survives the
/// app having several windows); a bundle ID follows whichever window that app
/// currently shows. An app with no bundle id — a bare executable, which is
/// what every CrossOver .exe is — is followed by the name LaunchServices gives
/// it instead, the one on its Dock tile (see --list-all).
struct Target {
    var bundleIDs: Set<String> = defaultBundleIDs
    var appNames: Set<String> = []
    var windowID: CGWindowID? = nil

    func matches(_ w: SCWindow) -> Bool {
        if let wid = windowID { return w.windowID == wid }
        guard let app = w.owningApplication else { return false }
        return bundleIDs.contains(app.bundleIdentifier)
            || appNames.contains(app.applicationName)
    }
}

var target = Target()

/// SCShareableContent, raced against a deadline.
///
/// Discovery stalls the same way the capture itself does (same WindowServer
/// connection), and unlike capture() nothing timeboxed it: the watch loop's
/// only discovery call could hang forever with no output at all. Measured:
/// 40 minutes of total silence from a live watch process
/// (/tmp/yomi-overlay.log 2026-08-09 20:14→20:54), ended only by a manual
/// "Restart capture".
func shareableContent(timeout: Double = sckDeadline) async throws -> SCShareableContent {
    try await withDeadline(timeout, orThrow: CaptureError.discoveryTimedOut(timeout)) {
        try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
    }
}

/// SCShareableContent, cached across passes and invalidated by measurement.
///
/// The call costs ~150 ms (measured: a `--bundle X` run that only enumerates
/// and exits takes 0.16 s against a 0.01 s process floor), and the watch loop
/// paid it TWICE per pass — once to choose the window, once inside
/// `captureOnce` to build the filter. That was 0.3 s of the ~0.9 s separating
/// a page turn from the recognition that reads it, spent re-deriving something
/// that had not changed.
///
/// Only two things are actually taken from the result: the target's `SCWindow`
/// handle, and the list of OTHER windows to exclude from the capture. Both are
/// functions of the set of windows the server is compositing, and CGWindowList
/// reports that set in 0.5 ms.
///
/// So the cache is invalidated by that set changing — NOT by a timer alone. A
/// window that appeared between two timed refreshes would be missing from the
/// exclusion list and would be composited straight into the capture, breaking
/// the scoping guarantee at the top of Capture.swift. The age limit below is a
/// second belt for what the on-screen list cannot express (a display arriving,
/// a window changing identity in place).
private var cachedContent: SCShareableContent? = nil
private var cachedContentSig: UInt64 = 0
private var cachedContentAt = Date.distantPast
private let contentMaxAge: TimeInterval = 10

/// FNV-1a over the window ids the server is compositing, front to back.
/// Order is part of the signature: the same windows restacked change which one
/// is frontmost, and frontmost is how the target is chosen.
func onScreenSignature(_ infos: [[String: Any]]) -> UInt64 {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for info in infos {
        let id = UInt64(UInt32(truncatingIfNeeded: (info[kCGWindowNumber as String] as? Int) ?? 0))
        for shift in stride(from: 0, to: 32, by: 8) {
            h = (h ^ ((id >> UInt64(shift)) & 0xff)) &* 0x100_0000_01b3
        }
    }
    return h
}

/// The shareable content for this pass: the cached one when the window set is
/// unchanged, a fresh enumeration otherwise.
func sharedContent(matching sig: UInt64) async throws -> SCShareableContent {
    if let c = cachedContent, sig == cachedContentSig,
        Date().timeIntervalSince(cachedContentAt) < contentMaxAge
    {
        return c
    }
    return try await refreshedContent(sig: sig)
}

/// Force a fresh enumeration and adopt it as the cache. Used when a capture
/// falls back to the window-scoped filter, which resolves geometry through the
/// SCWindow itself — a stale handle there would reintroduce the section-1 bug.
@discardableResult
func refreshedContent(sig: UInt64? = nil) async throws -> SCShareableContent {
    let c = try await shareableContent()
    cachedContent = c
    // With no signature (the -3811 fallback) keep this pass's: the content is
    // newer than it, and zeroing it made every pass in a Space that refuses
    // the display filter pay two ~150 ms enumerations. A changed window set
    // still changes the signature.
    if let sig { cachedContentSig = sig }
    cachedContentAt = Date()
    return c
}

/// The chosen window, paired with the frame the window server reports for it
/// on THIS pass, and the content its handle came from.
///
/// `SCWindow.frame` is a snapshot from whenever the enumeration ran, and that
/// enumeration is now cached across passes — so it can be a page-turn stale.
/// CGWindowList is re-read every pass anyway (`stillVisible`, 0.5 ms) and is
/// already the authority for which window is visible; take the geometry from
/// the same place. `window` is kept purely as a capture handle.
struct TargetWindow {
    let window: SCWindow
    let frame: CGRect
    let content: SCShareableContent
    var windowID: CGWindowID { window.windowID }
    /// Frame-local regions another window is drawn over — measured in the same
    /// pass as `frame`, so the two cannot disagree.
    var covers: [CGRect] = []
}

func targetWindows(in content: SCShareableContent) -> [SCWindow] {
    content.windows.filter { w in
        guard target.matches(w) else { return false }
        // Skip tiny helper/utility windows; the reader window is the big one.
        return w.frame.width > 200 && w.frame.height > 200
    }
    .sorted { a, b in
        // Visible windows first, then largest — capture of a window on an
        // inactive Space returns stale or empty frames.
        if a.isOnScreen != b.isOnScreen { return a.isOnScreen }
        return (a.frame.width * a.frame.height) > (b.frame.width * b.frame.height)
    }
}

func targetWindows() async throws -> [SCWindow] {
    // onScreenWindowsOnly must be false: a window living on another macOS Space
    // is not "on screen", so the target disappears from enumeration the moment you
    // switch desktops. Enumerate everything, then prefer visible windows.
    targetWindows(in: try await shareableContent())
}

/// The window to capture this pass, or nil when none is on screen.
///
/// `--bundle` follows an app, and an app commonly has several windows — three
/// browser windows, stacked or across Spaces. The deterministic answer to
/// "which one is the user reading?" is the app's FRONTMOST on-screen window:
/// CGWindowList enumerates on-screen windows front to back, so the first
/// candidate it lists wins. Size-based picking flips between same-size
/// windows; sticky picking latches onto a window that is still on screen but
/// occluded behind the one actually being read. Both were observed doing
/// exactly that.
func chooseWindow() async throws -> TargetWindow? {
    // The window server's on-screen list: windows it is compositing on the
    // ACTIVE Space right now, front to back. This is the authority, and
    // SCWindow.isOnScreen is not a substitute for it — a window sitting on
    // another Space can still report isOnScreen, which is how the overlay
    // ended up tracking a windowed browser on Space 1 while the user was
    // reading the same site fullscreen on Space 2: the page matched, so
    // lookups "worked", but every glyph was displaced by the difference
    // between the two windows' frames.
    //
    // Deliberately app-agnostic. A fullscreen game, a reader, a browser —
    // whatever the user is actually looking at is by definition what the
    // window server is compositing, and anything else is not capturable
    // anyway (no pixels on an inactive Space).
    let infos =
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var rank: [CGWindowID: Int] = [:]
    // Frames from the same list, not from SCWindow: the enumeration behind
    // SCWindow is cached across passes now, so its frames lag a move or a
    // resize by up to one cache lifetime. These are this instant's.
    var frames: [CGWindowID: CGRect] = [:]
    for (i, info) in infos.enumerated() {
        guard let id = info[kCGWindowNumber as String] as? Int else { continue }
        rank[CGWindowID(id)] = i
        if let r = windowRect(info) { frames[CGWindowID(id)] = r }
    }

    let content = try await sharedContent(matching: onScreenSignature(infos))
    let windows = content.windows.filter(target.matches)
    guard !windows.isEmpty else { return nil }

    // Second guard, for the parked-window case: the window server moves a
    // window belonging to another Space outside the desktop (x of -1459 and
    // -367 were both observed). Bare intersection is not enough — such a
    // window is typically clamped to leave a sliver on screen, and a sliver
    // still "intersects". Require most of the window to be visible: nobody
    // reads a window that is 97% off the display.
    //
    // "Visible" also means "not buried". Capture excludes every other window,
    // so a target with a chat app parked on top of it still yields pristine
    // pixels — on-screen, on the active Space, ≥50% within the display, and
    // completely hidden from the user. The overlay kept painting glyphs and
    // popups on top of whatever the user switched to (measured: a popup for
    // ほど still sitting over a Telegram window that fully covered the reader).
    // Ask the window server what it is actually drawing in front instead.
    let live: [TargetWindow] = windows.compactMap { w in
        // Skip tiny helper/utility windows; the reader window is the big one.
        guard rank[w.windowID] != nil, let f = frames[w.windowID],
            f.width > 200, f.height > 200,
            visibleFraction(of: w.windowID, frame: f, in: infos, rank: rank) >= 0.5
        else { return nil }
        return TargetWindow(window: w, frame: f, content: content)
    }
    guard var chosen = live.min(by: { rank[$0.windowID] ?? .max < rank[$1.windowID] ?? .max })
    else { return nil }
    // Partial cover is the common case — a chat window over half the reader.
    // The consumer needs the regions themselves, not just the verdict, so it
    // can refuse lookups on glyphs that are behind another window.
    chosen.covers = occluders(
        of: chosen.windowID, frame: chosen.frame,
        in: infos, rank: rank)
    return chosen
}

/// How much of a window the user can actually see: inside a display, and not
/// painted over by a window in front of it.
///
/// Sampled on a grid rather than by rect subtraction — overlapping occluders
/// double-count in an area sum, and 400 point tests are exact enough for a
/// threshold at a cost that does not matter.
func visibleFraction(
    of id: CGWindowID, frame f: CGRect,
    in infos: [[String: Any]], rank: [CGWindowID: Int]
) -> CGFloat {
    let displays = displayFrames()
    guard f.width > 0, f.height > 0, !displays.isEmpty else { return 1 }
    let covered = occluders(of: id, frame: f, in: infos, rank: rank)
    let steps = 20
    var shown = 0
    for i in 0..<steps {
        let x = f.minX + (CGFloat(i) + 0.5) * f.width / CGFloat(steps)
        for j in 0..<steps {
            let p = CGPoint(x: x, y: f.minY + (CGFloat(j) + 0.5) * f.height / CGFloat(steps))
            guard displays.contains(where: { $0.contains(p) }) else { continue }
            if covered.contains(where: { $0.contains(p) }) { continue }
            shown += 1
        }
    }
    return CGFloat(shown) / CGFloat(steps * steps)
}

/// The active displays, in the same top-left-origin space as window frames.
///
/// CoreGraphics, not NSScreen: this runs off the main thread every 150ms (see
/// stillVisible) where AppKit is not safe, and NSScreen.frame is
/// bottom-left-origin — intersecting it with a window rect agrees only by
/// accident, on one display whose origin is 0,0.
func displayFrames() -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

/// Regions of the window `id` that the window server is drawing another window
/// over, in screen points.
///
/// Only layer 0 counts. The menu bar, the Dock, notification banners and the
/// overlay's own panel (screen-saver level) all sit above every ordinary
/// window, so counting them would report every target as fully buried. A fully
/// transparent window hides nothing either.
///
/// Deliberately app-agnostic, like the selection above it: whatever the window
/// server composites in front of the reader is what the user is looking at.
func occluders(
    of id: CGWindowID, frame: CGRect,
    in infos: [[String: Any]], rank: [CGWindowID: Int]
) -> [CGRect] {
    guard let mine = rank[id] else { return [] }
    var out: [CGRect] = []
    // The list is front to back, so everything ahead of the target is on top.
    for info in infos.prefix(mine) {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
            ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.05,
            let r = windowRect(info)
        else { continue }
        let hit = r.intersection(frame)
        if !hit.isNull, hit.width > 1, hit.height > 1 { out.append(hit) }
    }
    return out
}

/// Is the window the last pass captured still the one the user is looking at?
///
/// CGWindowList only — no SCShareableContent, no capture — so it costs 0.5ms
/// (measured over 500 runs) and can be asked BETWEEN passes. That matters because the
/// overlay panel lives on every Space (the only way it can float over a reader
/// in native fullscreen): the moment you swipe to another desktop it is drawn
/// over whatever is there, and it stays until this process says otherwise.
/// Waiting for the next capture meant riding along for a whole pass —
/// measured 0.7s, and up to 1.3s when the pass includes an OCR read.
func stillVisible(_ id: CGWindowID) -> Bool {
    let infos =
        CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var rank: [CGWindowID: Int] = [:]
    for (i, info) in infos.enumerated() {
        if let n = info[kCGWindowNumber as String] as? Int { rank[CGWindowID(n)] = i }
    }
    // Off the active Space entirely: the window server stops listing it.
    guard
        let info = infos.first(where: {
            ($0[kCGWindowNumber as String] as? Int).map(CGWindowID.init) == id
        }), let frame = windowRect(info)
    else { return false }
    return visibleFraction(of: id, frame: frame, in: infos, rank: rank) >= 0.5
}

/// Bounds of a CGWindowList entry, in the same top-left-origin point space as
/// `SCWindow.frame`. Bounds bridge as NSNumber, not CGFloat — casting the
/// dictionary to [String: CGFloat] silently yields nil and drops every window.
func windowRect(_ info: [String: Any]) -> CGRect? {
    guard let b = info[kCGWindowBounds as String] as? [String: Any],
        let x = (b["X"] as? NSNumber)?.doubleValue,
        let y = (b["Y"] as? NSNumber)?.doubleValue,
        let w = (b["Width"] as? NSNumber)?.doubleValue,
        let h = (b["Height"] as? NSNumber)?.doubleValue,
        w > 0, h > 0
    else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
