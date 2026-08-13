// Which window the user is actually looking at, and how much of it they
// can see. ARCHITECTURE section 2 and 3 live here.

import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

// Default target when none is specified. Any window can be targeted instead —
// BOOK☆WALKER in a browser, a manga reader, a PDF viewer — via --bundle/--window.
let defaultBundleIDs: Set<String> = ["com.amazon.Lassen", "com.amazon.Kindle"]

/// What the capture is pinned to. A specific window ID is exact (survives the
/// app having several windows); a bundle ID follows whichever window that app
/// currently shows.
struct Target {
    var bundleIDs: Set<String> = defaultBundleIDs
    var windowID: CGWindowID? = nil

    func matches(_ w: SCWindow) -> Bool {
        if let wid = windowID { return w.windowID == wid }
        guard let app = w.owningApplication else { return false }
        return bundleIDs.contains(app.bundleIdentifier)
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
func shareableContent(timeout: Double = 12) async throws -> SCShareableContent {
    try await withThrowingTaskGroup(of: SCShareableContent.self) { group in
        group.addTask {
            try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
        }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            throw CaptureError.discoveryTimedOut(timeout)
        }
        guard let first = try await group.next() else {
            throw CaptureError.discoveryTimedOut(timeout)
        }
        group.cancelAll()
        return first
    }
}

func targetWindows() async throws -> [SCWindow] {
    // onScreenWindowsOnly must be false: a window living on another macOS Space
    // is not "on screen", so the target disappears from enumeration the moment you
    // switch desktops. Enumerate everything, then prefer visible windows.
    let content = try await shareableContent()
    return content.windows.filter { w in
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
func chooseWindow() async throws -> SCWindow? {
    let windows = try await targetWindows()
    guard !windows.isEmpty else { lastOccluders = []; return nil }

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
    let infos = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var rank: [CGWindowID: Int] = [:]
    for (i, info) in infos.enumerated() {
        if let id = info[kCGWindowNumber as String] as? Int { rank[CGWindowID(id)] = i }
    }

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
    let live = windows.filter {
        rank[$0.windowID] != nil
            && visibleFraction(of: $0.windowID, frame: $0.frame, in: infos, rank: rank) >= 0.5
    }
    guard let chosen = live.min(by: { rank[$0.windowID] ?? .max < rank[$1.windowID] ?? .max })
    else { lastOccluders = []; return nil }
    // Partial cover is the common case — a chat window over half the reader.
    // The consumer needs the regions themselves, not just the verdict, so it
    // can refuse lookups on glyphs that are behind another window.
    lastOccluders = occluders(of: chosen.windowID, frame: chosen.frame,
                              in: infos, rank: rank)
    return chosen
}

/// How much of a window the user can actually see: inside a display, and not
/// painted over by a window in front of it.
///
/// Sampled on a grid rather than by rect subtraction — overlapping occluders
/// double-count in an area sum, and 400 point tests are exact enough for a
/// threshold at a cost that does not matter.
func visibleFraction(of id: CGWindowID, frame f: CGRect,
                     in infos: [[String: Any]], rank: [CGWindowID: Int]) -> CGFloat {
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
func occluders(of id: CGWindowID, frame: CGRect,
               in infos: [[String: Any]], rank: [CGWindowID: Int]) -> [CGRect] {
    guard let mine = rank[id] else { return [] }
    var out: [CGRect] = []
    // The list is front to back, so everything ahead of the target is on top.
    for info in infos.prefix(mine) {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.05,
              let r = windowRect(info) else { continue }
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
    let infos = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var rank: [CGWindowID: Int] = [:]
    for (i, info) in infos.enumerated() {
        if let n = info[kCGWindowNumber as String] as? Int { rank[CGWindowID(n)] = i }
    }
    // Off the active Space entirely: the window server stops listing it.
    guard let info = infos.first(where: {
        ($0[kCGWindowNumber as String] as? Int).map(CGWindowID.init) == id
    }), let frame = windowRect(info) else { return false }
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
          w > 0, h > 0 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

/// What `chooseWindow()` last measured as drawn over the window it returned.
/// Read by the payload emitter; every payload and heartbeat carries it, since
/// a window can be covered and uncovered without a single pixel of the target
/// changing.
var lastOccluders: [CGRect] = []

/// True only when the target app owns the screen right now. Gates the
/// display-capture fallback so it can never photograph another application.
func isTargetFrontmost() -> Bool {
    guard let front = NSWorkspace.shared.frontmostApplication else { return false }

    // A pinned window id is the more specific target, and bundleIDs still holds
    // the default Kindle set in that case (--window never clears it). Comparing
    // against that set would reject every non-Kindle pinned window and gate off
    // the fullscreen fallback entirely — resolve the window's real owner instead.
    if let wid = target.windowID {
        let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, wid)
            as? [[String: Any]] ?? []
        guard let owner = info.first?[kCGWindowOwnerPID as String] as? pid_t else {
            return false
        }
        return owner == front.processIdentifier
    }

    guard let bid = front.bundleIdentifier else { return false }
    return target.bundleIDs.contains(bid)
}
