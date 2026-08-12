// KindleOCR — capture ONLY the Kindle window, OCR Japanese text, emit plain text.
//
// Scoping guarantee: the capture filter is constructed from a single SCWindow
// belonging to the Kindle process. There is no code path that captures the
// display, another app, or the desktop. If no Kindle window is found the tool
// exits non-zero rather than falling back to anything broader.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

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

struct Options {
    var vertical = false
    var watch = false
    var interval: Double = 1.5
    var outPath: String?
    var list = false
    var frame = false
    var debug = false
    var json = false
    var listAll = false
    var events = false
    var checkPerm = false
    var dumpPath: String?
    // Recognize a PNG from disk instead of capturing. Exists for the CER
    // harness (test/cer.py) and engine head-to-heads: same recognizer, same
    // output shape, but reproducible input — no window, no permission, no SCK.
    var imagePath: String?
    // Temporal voting: re-OCR a static page up to `votes` times (every
    // `voteEvery`th unchanged pass) and majority-vote per character. 0 or 1
    // disables. JSON watch mode only.
    var votes = 3
    var voteEvery = 2
    // With --image: dump detected tategaki cells as JSON instead of OCR.
    // Instrumentation for the Phase 5 splitter benchmark — measures the
    // geometry mechanism with no recognizer in the loop.
    var cellsDump = false
    // Debug: pre-commit orientation to horizontal. A one-shot --image run
    // always starts at .unknown (probe path, Live Text), so the
    // committed-horizontal code paths — Vision, furigana strip, the mixed
    // vertical-remainder merge — are otherwise untestable headlessly.
    var assumeHorizontal = false
    // Which modifier arms a lookup. Shift is the Yomitan/10ten default but
    // collides with shift-click and some IME candidate selection, so it is
    // configurable; the overlay passes whatever the user chose.
    var modifier = "shift"
}

/// Which recognizer reads the pixels. `auto` prefers Live Text and degrades to
/// Vision when the private classes are missing or misbehave; `vision` is the
/// one-line revert (INTEGRATION.md Phase 1).
enum EngineMode: String { case auto, vision, livetext }
var engineMode: EngineMode = .auto

/// Writes a captured frame to disk. Diagnostic only: what ScreenCaptureKit
/// actually hands back — image size and where the window sits inside it — is
/// the one thing the coordinate math depends on and cannot be inferred.
func dumpImage(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)
    else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

func parseArgs() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--vertical", "-v": o.vertical = true
        case "--assume-horizontal": o.assumeHorizontal = true
        case "--watch", "-w": o.watch = true
        case "--list", "-l": o.list = true
        case "--frame", "-f": o.frame = true
        case "--debug": o.debug = true
        case "--json", "-j": o.json = true
        case "--list-all": o.listAll = true
        case "--events": o.events = true
        case "--check-permission": o.checkPerm = true
        case "--dump":
            o.dumpPath = it.next()
            debugDumpPath = o.dumpPath
        case "--image":
            o.imagePath = it.next()
        case "--engine":
            if let e = it.next(), let m = EngineMode(rawValue: e.lowercased()) {
                engineMode = m
            } else {
                FileHandle.standardError.write(
                    "usage: --engine auto|vision|livetext\n".data(using: .utf8)!)
                exit(2)
            }
        case "--modifier":
            if let m = it.next() { o.modifier = m.lowercased() }
        case "--bundle":
            if let b = it.next() {
                if target.bundleIDs == defaultBundleIDs { target.bundleIDs = [] }
                target.bundleIDs.insert(b)
            }
        case "--window":
            if let w = it.next(), let id = UInt32(w) { target.windowID = CGWindowID(id) }
        case "--interval":
            if let s = it.next(), let d = Double(s) { o.interval = d }
        case "--votes":
            if let s = it.next(), let n = Int(s) { o.votes = n }
        case "--vote-every":
            if let s = it.next(), let n = Int(s) { o.voteEvery = max(1, n) }
        case "--cells":
            o.cellsDump = true
        case "--out", "-o": o.outPath = it.next()
        case "--help", "-h":
            print("""
            kindleocr — OCR the Kindle window only

              --list          list matching windows and exit
              --list-all      list every capturable window as JSON and exit
              --events        stream global modifier/click events as NDJSON
              --modifier NAME shift|control|option|command (default shift)
              --dump PATH     write the captured frame to a PNG (diagnostics)
              --image PATH    recognize a PNG from disk instead of capturing
              --assume-horizontal  debug: pre-commit horizontal orientation
                              (exercises the committed-horizontal paths headlessly)
              --engine NAME   auto|vision|livetext (default auto)
              --votes N       re-OCR a static page up to N times and majority-
                              vote per character (default 3; 0/1 disables)
              --vote-every N  vote on every Nth unchanged pass (default 2)
              --check-permission  report Screen Recording status as JSON
              --bundle ID     target an app by bundle id (repeatable)
              --window ID     target one specific window id
              --frame, -f     print Kindle window bounds as JSON and exit
              --vertical, -v  vertical (tategaki) reading order
              --watch, -w     re-capture continuously
              --interval N    seconds between captures in watch mode (default 1.5)
              --json, -j      emit NDJSON with per-character boxes
              --out PATH, -o  write text to PATH (default: stdout)
            """)
            exit(0)
        default:
            FileHandle.standardError.write("unknown argument: \(a)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    return o
}

/// Streams global Shift presses and clicks as NDJSON.
///
/// The overlay cannot see these itself: it is focusable:false (so Kindle keeps
/// keyboard focus) and click-through (so page turns still work), which means
/// only mouse-move messages ever reach it. A global monitor is the only way to
/// trigger a lookup without requiring the cursor to move.
///
/// Needs Accessibility permission. Without it the monitors silently never fire,
/// and the overlay falls back to shift+move.
func streamEvents(modifier: String) {
    let flag: NSEvent.ModifierFlags
    switch modifier {
    case "control", "ctrl": flag = .control
    case "option", "alt":   flag = .option
    case "command", "cmd":  flag = .command
    default:                flag = .shift
    }
    var wasDown = false

    func emit(_ type: String) {
        // Cocoa screen coords are bottom-left origin; convert to the top-left
        // origin every other part of this pipeline uses.
        let p = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        let y = screenHeight - p.y
        print("{\"type\":\"\(type)\",\"x\":\(Int(p.x)),\"y\":\(Int(y))}")
        fflush(stdout)
    }

    NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { ev in
        let down = ev.modifierFlags.contains(flag)
        // Fire on the press edge only, not on release or repeats.
        if down && !wasDown { emit("modifier") }
        wasDown = down
    }

    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { _ in
        emit("click")
    }

    // No Space-change notification here, though this is where one belongs:
    // NSWorkspace.activeSpaceDidChangeNotification never arrives in a process
    // with no windows of its own (measured — didActivateApplication arrives on
    // the same observer, through the same parking, several times a minute;
    // activeSpaceDidChange did not fire on a real swipe). The watch loop
    // notices instead, between captures — see stillVisible().

    FileHandle.standardError.write(
        "event monitor started (needs Accessibility permission)\n".data(using: .utf8)!)
}

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
    // is not "on screen", so Kindle disappears from enumeration the moment you
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

/// Which way the page's text runs. Sticky across passes: probing both
/// orientations costs a second Vision pass, which is the expensive step.
/// `verticalNative` is a vertical page Live Text reads directly, columns as
/// lines — no reflow (measured better than reflow: 99%/89% vs 94%/66%).
enum Orientation { case unknown, horizontal, vertical, verticalNative }
var orientation: Orientation = .unknown

/// Set by recognize() when a flat Live Text read came back as native vertical
/// columns; recognizeAuto turns it into orientation + the payload flag.
var flatReadNativeVertical = false

/// Set from --dump; lets the recognition stage write the rotated subject too.
var debugDumpPath: String?

/// A "horizontal" read that is really a vertical page misread across its
/// columns. The committed-horizontal escape used to be weight < 5 — but a
/// large-font tategaki page read horizontally yields plenty of accidental
/// cross-column runs (measured: 7–11 "lines", 80–96 glyphs on a vertical
/// kakuyomu page, so orientation stayed committed horizontal forever and the
/// furigana strip mutilated the columns every pass). The measurable
/// difference: real CJK text lines are dense (inter-char gap ≈ 0), while a
/// cross-column run places one char per column — median gap ≥ the column
/// pitch minus a glyph, well over half an em. Letter-spaced ruby text
/// (別天神) measures under ~0.5 em, so 0.6 keeps a margin to both.
func looksPicketFence(_ lines: [Line]) -> Bool {
    var considered = 0, picket = 0
    for line in lines where line.chars.count >= 3 {
        considered += 1
        var gaps: [Double] = []
        let cs = line.chars
        for i in 0..<(cs.count - 1) {
            gaps.append(cs[i + 1].x - (cs[i].x + cs[i].w))
        }
        let em = cs.map(\.h).sorted()[cs.count / 2]
        let medGap = gaps.sorted()[gaps.count / 2]
        if em > 0, medGap > 0.6 * em { picket += 1 }
    }
    // Majority of multi-char lines, and at least three of them — one spread
    // heading must not condemn a whole page.
    return picket >= 3 && picket * 5 > considered * 3
}

/// Mixed-content merge note, one stderr line per distinct message — every
/// committed-horizontal pass on a manga page would otherwise repeat it.
var lastMixedNote = ""

/// Columnar Live Text lines for text a committed-horizontal Vision read
/// cannot see. Vision reads no vertical Japanese at all (measured: 618 vs 6
/// chars), so manga dialogue and vertical ad banners on a page committed
/// horizontal simply vanish — a bookwalker manga page read 11 lines /
/// 105 glyphs of browser chrome and sound effects, zero dialogue.
///
/// Deliberately NOT gated on how much of the page the horizontal read
/// explains: one vertical banner on an otherwise fully-horizontal page must
/// be readable too. The only filters are correctness filters — a kept line
/// must be genuinely columnar (its own char quads stack taller than wide)
/// and must not overlap a recognised horizontal line (Vision's per-char
/// boxes are the better horizontal geometry; measured, the reason committed
/// horizontal uses Vision at all).
func verticalRemainder(_ subject: CGImage,
                       horizontal: [LiveText.RLine]) async -> [LiveText.RLine] {
    guard LiveText.usable else { return [] }
    guard let lt = await LiveText.analyze(subject), !lt.isEmpty else { return [] }
    let W = Double(subject.width), H = Double(subject.height)
    var out: [LiveText.RLine] = []
    for l in lt {
        guard l.chars.count >= 2 else { continue }
        let xs = l.chars.map { $0.box.midX * W }
        let ys = l.chars.map { $0.box.midY * H }
        guard (ys.max()! - ys.min()!) > (xs.max()! - xs.min()!) else { continue }
        let a = l.box
        var overlapped = false
        for h in horizontal {
            let inter = a.intersection(h.box)
            if !inter.isNull, inter.width * inter.height > 0.3 * a.width * a.height {
                overlapped = true
                break
            }
        }
        if !overlapped { out.append(l) }
    }
    return out
}

/// Recognise, deciding orientation by trying it.
///
/// Detection is empirical because the failure is total: Vision returns *nothing*
/// for tategaki rather than something misordered, so "which orientation yields
/// more text" is a reliable and cheap discriminator. The answer is cached and
/// only re-probed when the chosen orientation stops producing text — a page
/// turn from a vertical novel into a horizontal afterword should switch over
/// without the reader touching anything.
func recognizeAuto(_ image: CGImage, geometry: Geometry?, forced: Bool)
        async throws -> (lines: [Line], vertical: Bool) {
    func run(_ v: Bool) async throws -> [Line] {
        try await recognize(image, geometry: geometry, vertical: v)
    }
    func weight(_ ls: [Line]) -> Int { ls.reduce(0) { $0 + $1.text.count } }

    if forced {
        orientation = .vertical
        return (try await run(true), true)
    }
    switch orientation {
    case .horizontal:
        let h = try await run(false)
        if flatReadNativeVertical && weight(h) >= 5 {
            orientation = .verticalNative   // page turned into a vertical one
            return (h, true)
        }
        // Merged-vertical dominance: when the mixed-content merge's vertical
        // lines outweigh the horizontal read 2:1, this is a vertical page
        // wrongly committed, not a mixed page — and it must go through the
        // probe, because the committed path strips furigana bands from what
        // are actually columns and never marks ruby (measured on the
        // vertical furigana suite: 0.5% -> 37% CER when it stayed
        // committed). A genuinely mixed manga page stays: its horizontal
        // chrome and sound effects outweigh the dialogue columns.
        let vW = h.filter(\.vertical).reduce(0) { $0 + $1.text.count }
        let hW = h.filter { !$0.vertical }.reduce(0) { $0 + $1.text.count }
        if weight(h) >= 5, !looksPicketFence(h), vW <= 2 * hW {
            return (h, false)
        }
        if weight(h) >= 5 {
            let why = vW > 2 * hW ? "vertical-dominant (v=\(vW) h=\(hW))"
                                  : "a picket fence"
            FileHandle.standardError.write(
                "orientation: horizontal read is \(why) — re-probing\n"
                    .data(using: .utf8)!)
        }
        orientation = .unknown          // stopped working — re-probe below
    case .verticalNative:
        let h = try await run(false)
        if flatReadNativeVertical && weight(h) >= 5 { return (h, true) }
        orientation = .unknown
    case .vertical:
        let v = try await run(true)
        if weight(v) >= 5 { return (v, true) }
        orientation = .unknown
    case .unknown:
        break
    }

    let h = try await run(false)
    // A native vertical read needs no second probe: it already carries true
    // page geometry, and the reflow alternative measures worse (89% vs 66%).
    if flatReadNativeVertical && weight(h) >= 5 {
        orientation = .verticalNative
        FileHandle.standardError.write(
            "orientation: vertical (native Live Text read)\n".data(using: .utf8)!)
        return (h, true)
    }
    // A picket-fence "horizontal" read is column garbage, not evidence — at
    // face value its weight beats the reflow's and re-commits horizontal on
    // the very page that just escaped it.
    let hw = looksPicketFence(h) ? 0 : weight(h)
    let v = try await run(true)
    // Ties and near-ties go to horizontal: rotating a horizontal page still
    // recognises a little stray text (page furniture, single glyphs), and
    // treating that as a vertical page would scramble reading order.
    let vertical = weight(v) > hw * 2 && weight(v) >= 5
    if hw >= 5 || weight(v) >= 5 {
        orientation = vertical ? .vertical : .horizontal
        let mode = vertical ? "vertical (tategaki)" : "horizontal"
        let note = "orientation: \(mode) (h=\(hw) v=\(weight(v)) chars)\n"
        FileHandle.standardError.write(note.data(using: .utf8)!)
    }
    // The probe ran with the furigana strip OFF (it must — stripping a
    // vertical page's h-probe mutilates columns). Now that the page is
    // committed horizontal, one re-read applies the strip if there is
    // anything to strip.
    if !vertical, orientation == .horizontal, !detectRubyBands(image).isEmpty {
        return (try await run(false), false)
    }
    return (vertical ? v : h, vertical)
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

enum CaptureError: Error, CustomStringConvertible {
    case timedOut(Double)
    case discoveryTimedOut(Double)
    case noDisplay
    var description: String {
        switch self {
        case .timedOut(let s):
            return "capture timed out after \(s)s — this happens when Kindle is in "
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

    var maxX = 0, maxY = 0
    let step = 8      // coarse: a few thousand samples, not eleven million
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
    return CGSize(width: CGFloat(min(maxX + step, image.width)) / scale,
                  height: CGFloat(min(maxY + step, image.height)) / scale)
}

/// Races the capture against a deadline. SCScreenshotManager can stall
/// indefinitely on a fullscreen window belonging to another Space, which would
/// otherwise wedge the whole watch loop.
func capture(window: SCWindow, timeout: Double = 12) async throws -> Capture {
    nonisolated(unsafe) let w = window
    return try await withThrowingTaskGroup(of: Capture.self) { group in
        group.addTask { try await captureOnce(window: w) }
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

/// The window's true on-screen origin.
///
/// `SCWindow.frame.origin` is right for an ordinary window and wrong for a
/// fullscreen one — macOS keeps reporting the pre-fullscreen rect. When the
/// measured content covers a whole display, the window is that display's
/// fullscreen occupant and its origin is the display's.
func trueOrigin(window: SCWindow, measured: CGSize?, display: SCDisplay) -> CGPoint {
    guard let m = measured else { return window.frame.origin }
    if abs(m.width - display.frame.width) <= 4, abs(m.height - display.frame.height) <= 4 {
        return display.frame.origin
    }
    return window.frame.origin
}

func captureOnce(window: SCWindow) async throws -> Capture {
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
    let content = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: false)
    guard let display = content.displays.first(where: { $0.frame.intersects(window.frame) })
            ?? content.displays.first else {
        throw CaptureError.noDisplay
    }

    func finish(_ image: CGImage, scale: CGFloat) -> Capture {
        let measured = contentExtent(image, scale: scale)
        return Capture(
            image: image,
            region: display.frame,
            origin: trueOrigin(window: window, measured: measured, display: display),
            size: measured ?? window.frame.size)
    }

    do {
        let others = content.windows.filter { $0.windowID != window.windowID }
        let filter = SCContentFilter(display: display, excludingWindows: others)
        return finish(try await shoot(filter), scale: CGFloat(filter.pointPixelScale))
    } catch {
        // Some fullscreen Spaces refuse the display filter (-3811). Including
        // just this window behaves the same way for coordinates: content at the
        // image origin, scaled against the display.
        let filter = SCContentFilter(display: display, including: [window])
        return finish(try await shoot(filter), scale: CGFloat(filter.pointPixelScale))
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

struct Line {
    var text: String
    var box: CGRect  // normalized, origin bottom-left
    var chars: [CharBox] = []
    // Furigana (ruby) line: excluded from lookups and text output, kept in
    // the payload as a reading hint for its base line (Phase 4).
    var ruby = false
    // This line reads top-to-bottom. Per-LINE, not per-page: a native Live
    // Text read of a vertical page returns the page's horizontal furniture
    // (site headers, titles) in the same pass as the columns, and the popup
    // must place against the orientation of the line actually hit, not the
    // page majority. The payload-level `vertical` stays as the page-majority
    // fallback.
    var vertical = false
    // Concatenated ruby text of the furigana lines attached to this line.
    var hint: String? = nil
}

/// A box in normalised image coordinates with a TOP-LEFT origin.
///
/// Vision reports bottom-left normalised boxes; everything downstream of here
/// is top-left. Converting once, up front, is what makes the vertical-text
/// rotation expressible as four lines of arithmetic instead of a sign-error
/// hunt through three coordinate systems.
struct NBox {
    var x: Double, y: Double, w: Double, h: Double

    init(vision b: CGRect) {
        x = b.minX; y = 1 - b.maxY; w = b.width; h = b.height
    }
    init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }

    /// Undo a 90° counter-clockwise image rotation.
    ///
    /// Rotating the image CCW maps original (x,y) to (y, W−x); inverting that
    /// and renormalising against the original dimensions collapses to this.
    /// Derived and checked against a worked example: a 22pt glyph at (100,50)
    /// in a 900x680 image round-trips exactly.
    var unrotatedCCW: NBox {
        NBox(x: 1 - y - h, y: x, w: h, h: w)
    }
}

/// Rotate 90° counter-clockwise, so tategaki becomes ordinary horizontal text.
///
/// CCW specifically: a column reads top-to-bottom and columns run right-to-left,
/// so rotating CCW puts the first character of the rightmost column at the top
/// LEFT. Vision then returns lines in true reading order — the rightmost column
/// first — and characters within each line already left-to-right. Rotating the
/// other way would reverse both.
func rotated90CCW(_ image: CGImage) -> CGImage? {
    let w = image.width, h = image.height
    guard let space = image.colorSpace,
          let ctx = CGContext(data: nil, width: h, height: w,
                              bitsPerComponent: image.bitsPerComponent,
                              bytesPerRow: 0, space: space,
                              bitmapInfo: image.bitmapInfo.rawValue)
    else { return nil }
    // CGContext is bottom-left; rotating by +90° and shifting puts the source
    // rect back inside the (h x w) canvas.
    ctx.translateBy(x: CGFloat(h), y: 0)
    ctx.rotate(by: .pi / 2)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}


// MARK: - Tategaki reflow
//
// Rotating a vertical page does NOT work, and this is measured, not assumed:
// rotating makes the columns horizontal but leaves every glyph on its side,
// because CJK characters are upright inside a vertical column. Vision returns
// zero lines for both the original and the rotated image (189 characters on a
// real vertical page, 0 recognised either way).
//
// So instead of rotating, re-flow: find the columns, cut each into character
// cells, and paint those already-upright cells side by side into an ordinary
// horizontal strip. Vision reads that natively, and because we know which cell
//每 character came from, per-glyph boxes map straight back to the page.

/// A character cell on the page, in image pixels.
struct Cell { let rect: CGRect }

/// Ink mask of an image, downsampled by `step`, as a [width][height] grid.
private func inkMask(_ image: CGImage, step: Int) -> (w: Int, h: Int, ink: [Bool])? {
    guard let data = image.dataProvider?.data as Data? else { return nil }
    let bpr = image.bytesPerRow
    let bpp = max(1, image.bitsPerPixel / 8)
    guard bpp >= 3 else { return nil }
    let w = image.width / step, h = image.height / step
    guard w > 4, h > 4 else { return nil }
    var ink = [Bool](repeating: false, count: w * h)
    for gy in 0..<h {
        let row = (gy * step) * bpr
        for gx in 0..<w {
            let i = row + (gx * step) * bpp
            guard i + 3 < data.count else { continue }
            let b0 = data[i], b1 = data[i + 1], b2 = data[i + 2], b3 = data[i + 3]
            // Transparent pixels are all-zero when premultiplied, which reads
            // as pure black to a naive luminance test — and the area of the
            // capture not covered by the window is entirely transparent, so
            // without this the whole page is "ink" and every column merges.
            if b0 == 0 && b1 == 0 && b2 == 0 && b3 == 0 { continue }
            // Darkest channel, so the test works whatever the channel order.
            let darkest = min(min(b0, b1), min(b2, b3))
            ink[gy * w + gx] = darkest < 110
        }
    }
    return (w, h, ink)
}

/// Runs of consecutive indices whose count exceeds `minInk`, separated by gaps
/// of at least `minGap`.
private func runs(_ counts: [Int], minInk: Int, minGap: Int) -> [(Int, Int)] {
    var out: [(Int, Int)] = []
    var start: Int? = nil
    var gap = 0
    for (i, c) in counts.enumerated() {
        if c > minInk {
            if start == nil { start = i }
            gap = 0
        } else if let s = start {
            gap += 1
            if gap >= minGap { out.append((s, i - gap)); start = nil; gap = 0 }
        }
    }
    if let s = start { out.append((s, counts.count - 1)) }
    return out
}

/// Columns (right to left) of character cells (top to bottom), in image pixels.
func tategakiCells(_ image: CGImage) -> [[Cell]] {
    let step = 4
    guard let m = inkMask(image, step: step) else { return [] }

    // Columns: ink projected onto x. A column of text is a solid vertical band.
    var colInk = [Int](repeating: 0, count: m.w)
    for y in 0..<m.h { for x in 0..<m.w where m.ink[y * m.w + x] { colInk[x] += 1 } }
    let colRuns = runs(colInk, minInk: 1, minGap: 2)
    guard !colRuns.isEmpty else { return [] }

    // Cells are found at PIXEL resolution. The coarse mask that finds
    // columns loses every gap under `step` pixels, which below ~20px glyphs
    // is every real gap — measured: recall 0.39 at 14px, 0.55 at 18px, with
    // fragments and merges both. One fine mask serves all columns.
    guard let f = inkMask(image, step: 1) else { return [] }

    var columns: [[Cell]] = []
    for (cx0, cx1) in colRuns {
        let width = cx1 - cx0 + 1
        if width < 2 { continue }
        let px0 = cx0 * step, px1 = min((cx1 + 1) * step - 1, f.w - 1)
        let em = Double(px1 - px0 + 1)
        var rowInk = [Int](repeating: 0, count: f.h)
        for y in 0..<f.h {
            var n = 0
            for x in px0...px1 where f.ink[y * f.w + x] { n += 1 }
            rowInk[y] = n
        }
        // Character cells are ink runs along the column, NOT fixed-pitch
        // slices — line spacing is a reader setting, and pitch-slicing cut
        // glyphs in half (measured, 45% placement). Three stages:
        //
        // 1. Fine runs. The gap threshold only needs to skip antialiasing
        //    haze; real structure is decided by the merge below.
        let raw = runs(rowInk, minInk: 0, minGap: max(1, Int(em * 0.08)))
        // 2. Merge stroke runs into glyphs. 二 and 川 split into strokes at
        //    pixel resolution (intra-glyph gaps reach ~0.45em — larger than
        //    the inter-char gap at tight pitch, so gap size alone cannot
        //    decide). The em cap is what distinguishes: strokes of one glyph
        //    combine to ≤ ~1 em, merging across a char boundary would exceed
        //    it.
        var merged: [(Int, Int)] = []
        for r in raw {
            if let last = merged.last,
               Double(r.1 - last.0 + 1) <= em * 1.15,
               Double(r.0 - last.1 - 1) < em * 0.45 {
                merged[merged.count - 1] = (last.0, r.1)
            } else {
                merged.append(r)
            }
        }
        // 3. Runs much taller than the em are touching glyphs (dense pitch):
        //    split back on em boundaries.
        var spans: [(Double, Double)] = []   // (y0, height) in pixels
        for (a, b) in merged {
            let hgt = Double(b - a + 1)
            let n = max(1, Int((hgt / em).rounded()))
            let each = hgt / Double(n)
            for k in 0..<n { spans.append((Double(a) + Double(k) * each, each)) }
        }
        // 4. Normalize small cells toward the em box. A cell is the CHAR's
        //    box, not its ink bounds: 、。っ ink occupies a corner of the em
        //    square, and a tight ink box misses where the glyph actually
        //    lives (measured as the small-kana/punctuation placement
        //    failures). Expand to ~0.9em centered on the ink, taking at most
        //    half of each neighboring gap so cells never overlap.
        var cells: [Cell] = []
        for (i, s) in spans.enumerated() {
            var top = s.0, hgt = s.1
            if hgt < em * 0.85 {
                let mid = top + hgt / 2
                let want = em * 0.9
                let prevEdge = i > 0 ? spans[i - 1].0 + spans[i - 1].1 : -1e9
                let nextEdge = i + 1 < spans.count ? spans[i + 1].0 : 1e9
                let minTop = top - (top - prevEdge) / 2
                let maxBot = (top + hgt) + (nextEdge - top - hgt) / 2
                top = max(minTop, mid - want / 2)
                hgt = min(maxBot, mid + want / 2) - top
            }
            cells.append(Cell(rect: CGRect(
                x: Double(px0), y: top, width: em, height: hgt)))
        }
        if !cells.isEmpty { columns.append(cells) }
    }
    // Tategaki reads right to left.
    return columns.sorted { ($0.first?.rect.minX ?? 0) > ($1.first?.rect.minX ?? 0) }
}

/// Paint cells into a horizontal strip: one row per column, cells left to right.
/// Returns the strip plus, for each row, the source cells in order.
func reflowStrip(_ image: CGImage, columns: [[Cell]])
        -> (image: CGImage, rows: [[Cell]], cell: Int, pad: Int)? {
    guard !columns.isEmpty else { return nil }
    let cell = Int(columns.flatMap { $0 }.map(\.rect.width).max() ?? 0)
    guard cell > 2 else { return nil }
    let pad = max(2, cell / 4)
    let widest = columns.map(\.count).max() ?? 0
    let stripW = widest * (cell + pad) + pad
    let stripH = columns.count * (cell + pad) + pad
    guard stripW > 0, stripH > 0, stripW < 20000, stripH < 20000,
          let space = image.colorSpace,
          let ctx = CGContext(data: nil, width: stripW, height: stripH,
                              bitsPerComponent: image.bitsPerComponent,
                              bytesPerRow: 0, space: space,
                              bitmapInfo: image.bitmapInfo.rawValue)
    else { return nil }
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: stripW, height: stripH))

    for (ri, col) in columns.enumerated() {
        for (ci, c) in col.enumerated() {
            guard let crop = image.cropping(to: c.rect) else { continue }
            let x = pad + ci * (cell + pad)
            // CGContext is bottom-left; rows run down the page.
            let yTop = pad + ri * (cell + pad)
            let y = stripH - yTop - cell
            ctx.draw(crop, in: CGRect(x: x, y: y, width: cell, height: cell))
        }
    }
    guard let out = ctx.makeImage() else { return nil }
    return (out, columns, cell, pad)
}

// MARK: - Live Text (private VisionKit path)
//
// The Tier-1 recognizer swap from INTEGRATION.md Phase 1. Vision cannot read
// tategaki at all (measured above); Apple's Live Text can, but only through
// the PRIVATE VisionKitCore classes — the public ImageAnalysis API exposes a
// bare `transcript`, no geometry. This binding follows the two working
// open-source precedents byte for byte: ocrmac's PyObjC calls (class names,
// requestType=1, the completion-block shape, the run-loop wait) and WebKit's
// SPI header (allLines/string/quad/children object graph). Cited third-party
// measurement to re-validate here: 618 chars read on a real vertical Kindle
// page where Vision read 6.
//
// Defensive posture, because the API is private and has broken between OS
// releases (class prefixes and a callback selector both changed historically):
// classes are looked up at runtime, every analysis has a hard timeout, and
// three consecutive failures permanently degrade this process to Vision with
// one stderr line. Live Text emits NO confidence signal (ocrmac hardcodes
// 1.0) — never treat its output as high-confidence.
enum LiveText {
    struct Char { let ch: String; let box: CGRect }   // normalized, TOP-LEFT origin
    struct RLine { let text: String; let box: CGRect; let chars: [Char] }

    // VKCImageAnalyzer lives in VisionKitCore.framework, which a plain CLI
    // does not link. dlopen once, then look the classes up.
    private static let analyzerClass: AnyClass? = {
        if let c = NSClassFromString("VKCImageAnalyzer") { return c }
        dlopen("/System/Library/PrivateFrameworks/VisionKitCore.framework/VisionKitCore",
               RTLD_NOW)
        return NSClassFromString("VKCImageAnalyzer")
    }()
    private static let requestClass: AnyClass? = NSClassFromString("VKCImageAnalyzerRequest") != nil
        ? NSClassFromString("VKCImageAnalyzerRequest")
        : { _ = analyzerClass; return NSClassFromString("VKCImageAnalyzerRequest") }()

    private static var consecutiveFailures = 0
    private static var broken = false
    static var usable: Bool {
        !broken && analyzerClass != nil && requestClass != nil
    }

    private static func failed(_ why: String) {
        consecutiveFailures += 1
        if consecutiveFailures >= 3 { broken = true }
        let state = broken ? "disabled for this session" : "falling back this pass"
        FileHandle.standardError.write(
            "livetext: \(why); \(state)\n".data(using: .utf8)!)
    }

    /// -[obj sel] for a selector returning an ObjC object.
    private static func msg(_ obj: AnyObject, _ sel: String) -> AnyObject? {
        let s = NSSelectorFromString(sel)
        guard obj.responds(to: s) else { return nil }
        return obj.perform(s)?.takeUnretainedValue()
    }

    /// -[quad boundingBox] — struct return, so raw IMP, not perform().
    /// The rect is normalized with a TOP-LEFT origin (ocrmac flips it to get
    /// Vision's bottom-left; we want top-left, so it is used as-is).
    private static func quadBox(_ obj: AnyObject) -> CGRect {
        guard let quad = msg(obj, "quad") else { return .zero }
        let sel = NSSelectorFromString("boundingBox")
        guard let cls: AnyClass = object_getClass(quad),
              let imp = class_getMethodImplementation(cls, sel) else { return .zero }
        typealias RectFn = @convention(c) (AnyObject, Selector) -> CGRect
        return unsafeBitCast(imp, to: RectFn.self)(quad, sel)
    }

    private enum Outcome { case ok([RLine]); case error; case timeout }

    /// One analysis pass over `image`. nil = the engine failed this pass and
    /// the caller must fall back to Vision.
    ///
    /// Async, and necessarily so — measured, not inferred. The completion is
    /// delivered through the main dispatch queue, and this process's main
    /// thread only drains that queue while the main task is SUSPENDED (Swift
    /// async-main). Every synchronous wait tried here failed in the capture
    /// path: a main-thread nested run-loop spin cannot re-enter the
    /// main-queue drain (it only worked pre-first-await, where --image runs);
    /// a dedicated worker thread's loop never sees the completion; a
    /// semaphore blocks the drain outright. Awaiting a continuation is the
    /// one shape that frees the main thread to drain while VisionKit works.
    static func analyze(_ image: CGImage) async -> [RLine]? {
        guard usable,
              let anaCls: AnyObject = analyzerClass,
              let reqCls: AnyObject = requestClass else { return nil }

        let nsImage = NSImage(cgImage: image,
                              size: NSSize(width: image.width, height: image.height))

        // [[VKCImageAnalyzerRequest alloc] initWithImage:requestType:1]
        // (1 = VKAnalysisTypeText). The scalar argument rules out perform();
        // call the IMP directly.
        guard let reqAlloc = performAlloc(reqCls) else {
            failed("alloc failed"); return nil
        }
        let initSel = NSSelectorFromString("initWithImage:requestType:")
        guard let reqInstCls: AnyClass = object_getClass(reqAlloc),
              let initImp = class_getMethodImplementation(reqInstCls, initSel) else {
            failed("initWithImage:requestType: missing"); return nil
        }
        typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, Int) -> AnyObject?
        guard let request = unsafeBitCast(initImp, to: InitFn.self)(
                  reqAlloc, initSel, nsImage, 1) else {
            failed("request init returned nil"); return nil
        }
        // Same language hint as the Vision path.
        _ = request.perform(NSSelectorFromString("setLocales:"),
                            with: ["ja-JP", "en-US"] as NSArray)

        guard let anaAlloc = performAlloc(anaCls),
              let analyzer = msg(anaAlloc, "init") else {
            failed("analyzer init failed"); return nil
        }

        // processRequest:progressHandler:completionHandler: — block shapes
        // from ocrmac's hand-declared metadata: progress (double),
        // completion (analysis, error).
        let procSel = NSSelectorFromString("processRequest:progressHandler:completionHandler:")
        guard let anaInstCls: AnyClass = object_getClass(analyzer),
              let procImp = class_getMethodImplementation(anaInstCls, procSel) else {
            failed("processRequest selector missing"); return nil
        }
        typealias ProgressBlk = @convention(block) (Double) -> Void
        typealias CompleteBlk = @convention(block) (AnyObject?, AnyObject?) -> Void
        typealias ProcFn = @convention(c)
            (AnyObject, Selector, AnyObject, @escaping ProgressBlk, @escaping CompleteBlk) -> Void

        // Resume-once guard shared by the completion and the watchdog.
        let lock = NSLock()
        var resumed = false
        func firstResume() -> Bool {
            lock.lock(); defer { lock.unlock() }
            if resumed { return false }
            resumed = true
            return true
        }

        let outcome: Outcome = await withCheckedContinuation { cont in
            let complete: CompleteBlk = { analysis, error in
                guard firstResume() else { return }
                if error == nil, let analysis {
                    cont.resume(returning: .ok(extract(analysis)))
                } else {
                    cont.resume(returning: .error)
                }
            }
            unsafeBitCast(procImp, to: ProcFn.self)(
                analyzer, procSel, request, { _ in }, complete)
            // Watchdog: a hung analysis must degrade, not stall the watch loop.
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                guard firstResume() else { return }
                cont.resume(returning: .timeout)
            }
        }

        switch outcome {
        case .ok(let lines):
            // alloc/init handed us +1 refs; the analysis is over, balance them.
            Unmanaged.passUnretained(request).release()
            Unmanaged.passUnretained(analyzer).release()
            consecutiveFailures = 0
            return lines
        case .error:
            Unmanaged.passUnretained(request).release()
            Unmanaged.passUnretained(analyzer).release()
            failed("analysis error")
            return nil
        case .timeout:
            // The analysis may still be running and touch these objects;
            // leaking two small objects on a rare path beats a use-after-free.
            failed("completion timeout")
            return nil
        }
    }

    /// +[cls alloc] via perform (object-returning, so perform is safe).
    private static func performAlloc(_ cls: AnyObject) -> AnyObject? {
        cls.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    }

    /// Walk analysis.allLines() -> line.string()/quad()/children(). Children
    /// are per-character for CJK; latin tokens can be multi-character, whose
    /// box is subdivided evenly so downstream always sees one entry per char.
    private static func extract(_ analysis: AnyObject) -> [RLine] {
        guard let all = msg(analysis, "allLines") as? [AnyObject] else { return [] }
        var out: [RLine] = []
        for lineObj in all {
            guard let text = msg(lineObj, "string") as? String, !text.isEmpty
            else { continue }
            var chars: [Char] = []
            if let children = msg(lineObj, "children") as? [AnyObject] {
                for c in children {
                    guard let s = msg(c, "string") as? String, !s.isEmpty else { continue }
                    let box = quadBox(c)
                    let n = s.count
                    if n == 1 {
                        chars.append(Char(ch: s, box: box))
                    } else {
                        let w = box.width / CGFloat(n)
                        for (i, ch) in s.enumerated() {
                            if String(ch).trimmingCharacters(in: .whitespaces).isEmpty { continue }
                            chars.append(Char(ch: String(ch),
                                              box: CGRect(x: box.minX + CGFloat(i) * w,
                                                          y: box.minY,
                                                          width: w, height: box.height)))
                        }
                    }
                }
            }
            out.append(RLine(text: text, box: quadBox(lineObj), chars: chars))
        }
        return out
    }
}

/// One character with its on-screen rectangle, in window points with the
/// origin at the window's top-left — directly usable as CSS left/top/width/height.
struct CharBox {
    var ch: String
    var x: Double, y: Double, w: Double, h: Double
    // Cross-pass agreement fraction from temporal voting (nil = single pass).
    // No engine here supplies real per-character confidence — Live Text
    // exposes none at all — so agreement across re-reads of a static page is
    // the confidence signal every downstream lever gates on.
    var conf: Double? = nil
}

func jsonEscape(_ s: String) -> String {
    var out = ""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        case "\r": out += "\\r"
        default:
            if u.value < 0x20 {
                out += String(format: "\\u%04x", u.value)
            } else {
                out.unicodeScalars.append(u)
            }
        }
    }
    return out
}

/// Where a recognised box lands on screen, and how to express it in the
/// overlay's coordinate system.
///
/// `region` is what the image covers; `window` is what the overlay is pinned
/// to. Vision reports normalised coordinates, so a box is first mapped into
/// `region`, then rebased onto `window`. When the two are the same rectangle —
/// the ordinary window-filter capture — this collapses to a plain scale.
struct Geometry {
    let region: CGRect
    let window: CGRect
}

func recognize(_ image: CGImage, geometry: Geometry? = nil,
               vertical: Bool = false) async throws -> [Line] {
    // Vision cannot read tategaki at all — measured on a real vertical page:
    // 189 characters present, 0 recognised, 0 lines.
    // Vertical pages are re-flowed, not rotated — see the tategaki section.
    var reflow: (image: CGImage, rows: [[Cell]], cell: Int, pad: Int)? = nil
    if vertical {
        let cols = tategakiCells(image)
        reflow = reflowStrip(image, columns: cols)
    }
    var subject = reflow?.image ?? image
    if vertical, let dp = debugDumpPath { dumpImage(subject, to: dp + ".rot.png") }

    // Furigana removal BEFORE recognition — ONLY once the page is COMMITTED
    // horizontal. Running it during the h-probe of a vertical page erases
    // pieces of columns (a vertical page's row projection is full of
    // band-like runs) and cost 5x CER on the vertical suites, measured.
    // recognizeAuto re-reads once right after the probe commits horizontal,
    // so ruby'd pages still get the strip on their first real read.
    var hintBands: [(rect: CGRect, text: String)] = []
    let stripEligible = !vertical && reflow == nil && orientation == .horizontal
    if stripEligible {
        let candidates = detectRubyBands(subject)
        // Vet candidates by TEXT before erasing. Geometry alone swallowed a
        // magazine page's body line sitting above a bigger section header
        // (same 30–65% height ratio as real ruby), making that line
        // permanently unrecognizable. Furigana reads as kana; a body line
        // reads kanji-heavy and stays.
        //
        // Vetting happens per ROW GROUP, not per band: the projection is
        // per-slice, so one body line yields up to six independent bands,
        // and a lone slice's fragment can be kana-heavy (れてしまった。 —
        // measured 0.86 kana, erased, beheading the line) even though the
        // physical line is kanji-rich. Bands sharing rows are one line;
        // their concatenated text is what gets judged.
        var groups: [[Int]] = []
        for (i, b) in candidates.enumerated() {
            if let gi = groups.firstIndex(where: { g in
                let a = candidates[g[0]]
                return b.minY < a.maxY && a.minY < b.maxY
            }) {
                groups[gi].append(i)
            } else {
                groups.append([i])
            }
        }
        // ONE Vision call for every candidate band, not one per band: a
        // decorated Kindle page yields 6–9 candidates per pass, and per-band
        // reads stretched the pass past the idle timer — the overlay flapped
        // hidden mid-read (measured: 8–22s between payloads,
        // /tmp/yomi-overlay.log 2026-08-10 21:15). Bands are stacked into a
        // single strip with white gaps and read once; recognised lines map
        // back to their band by vertical position.
        var texts = [String](repeating: "", count: candidates.count)
        if !candidates.isEmpty {
            // Gap must exceed any plausible line spacing inside the strip or
            // Vision merges adjacent bands into one line.
            let gap = 24
            let compW = Int(candidates.map(\.width).max() ?? 0)
            let compH = candidates.reduce(0) { $0 + Int($1.height) } +
                gap * candidates.count
            if compW > 0,
               let ctx = CGContext(data: nil, width: compW, height: compH,
                                   bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: compW, height: compH))
                var segments: [(y0: Int, y1: Int)] = []   // top-left rows
                var yTop = 0
                for b in candidates {
                    let h = Int(b.height)
                    if let crop = subject.cropping(to: b) {
                        // CGContext origin is bottom-left; segments are kept
                        // top-left to match visionLines' boxes.
                        ctx.draw(crop, in: CGRect(x: 0, y: compH - yTop - h,
                                                  width: Int(b.width), height: h))
                    }
                    segments.append((yTop, yTop + h))
                    yTop += h + gap
                }
                if let comp = ctx.makeImage(),
                   let ls = try? visionLines(comp, unrotate: false, wantChars: false) {
                    for l in ls {
                        let midY = l.box.midY * Double(compH)
                        if let si = segments.firstIndex(where: {
                            Double($0.y0) <= midY && midY < Double($0.y1 + gap / 2)
                        }) {
                            texts[si] += l.text
                        }
                    }
                    for i in texts.indices {
                        texts[i] = texts[i]
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
            }
        }
        var erase: [CGRect] = []
        for g in groups {
            let joined = g.map { texts[$0] }.joined()
            // A row nothing can read still erases: it contributes nothing to
            // recognition either way, and unstripped tiny ruby re-triggers
            // the fusion bug (別天神+こと… -> 前実, measured).
            guard joined.isEmpty || kanaFraction(joined) >= 0.7 else { continue }
            for i in g {
                erase.append(candidates[i])
                if !texts[i].isEmpty { hintBands.append((candidates[i], texts[i])) }
            }
        }
        if !erase.isEmpty, let clean = eraseBands(subject, erase) {
            FileHandle.standardError.write(
                "furigana: stripped \(erase.count) of \(candidates.count) bands\n"
                    .data(using: .utf8)!)
            subject = clean
        }
    }

    // Engine dispatch. Both engines are normalized to one intermediate shape
    // — lines with per-character boxes in top-left normalized subject
    // coordinates — so the strip mapping and the flat path below never know
    // which engine ran. A Live Text failure falls back to Vision for that
    // pass; three consecutive failures disable it for the session.
    // Engine policy, each engine where it measured best:
    //   - Vertical pages: Live Text (reads tategaki natively; Vision cannot).
    //   - Horizontal COMMITTED pages: Vision. Its boundingBox(for:) gives
    //     true per-character ranges, while LT emits multi-char tokens whose
    //     even-width subdivision drifts on letter-spaced lines — measured as
    //     the +1-char span shift on ruby-spread Kindle text (が's span over
    //     生's pixels). Vision horizontal CER is also better (0.3% vs 0.6%).
    //   - The reflow strip: Vision (LT re-segments across cells, 66% vs 77%).
    //   - Probe passes (orientation unknown): LT, so the native-vertical
    //     detection below can fire; the post-probe re-read lands on Vision.
    var raw: [LiveText.RLine]? = nil
    if engineMode != .vision, LiveText.usable, reflow == nil,
       engineMode == .livetext || orientation != .horizontal {
        raw = await LiveText.analyze(subject)
    }
    // Which engine actually ran, once per switch. "auto" resolving to vision
    // silently would make a broken Live Text invisible; say so.
    logEngineOnce(raw != nil ? "livetext" : "vision")
    flatReadNativeVertical = false
    if let lt = raw, reflow == nil, !vertical {
        // Live Text on a vertical page produces one of two shapes.
        //
        // Shape 1 (the documented artifact): ONE CHARACTER PER LINE. A read
        // that is mostly single CJK characters is a vertical page misread
        // flat: report nothing, so recognizeAuto's probe flips to the reflow
        // path — the same degrade-honestly rule as window selection.
        let singles = lt.filter {
            $0.text.count == 1 && isCJK($0.text.unicodeScalars.first!)
        }.count
        if lt.count >= 8, Double(singles) > 0.7 * Double(lt.count) { return [] }
        // Shape 2 (measured on the DOM-truth suite, 99%/89%): whole COLUMNS
        // as lines — tall, narrow, multi-character, in reading order, with
        // true page-position quads. Keep that read and tell recognizeAuto it
        // was a native vertical one.
        let W = Double(subject.width), H = Double(subject.height)
        let cjk = lt.filter { l in
            l.text.count >= 2 && l.text.unicodeScalars.contains(where: isCJK)
        }
        let columnar = cjk.filter { ($0.box.height * H) > 2 * ($0.box.width * W) }
        if cjk.count >= 2, columnar.count * 2 >= cjk.count {
            flatReadNativeVertical = true
        }
    }
    var lines: [LiveText.RLine] = try raw
        ?? visionLines(subject, unrotate: vertical && reflow == nil,
                       wantChars: geometry != nil || reflow != nil)

    // Mixed-content completeness: a committed-horizontal page can still
    // CONTAIN vertical text (manga dialogue, kakuyomu ad banners), which
    // Vision cannot see. Every committed-horizontal Vision pass gets one
    // Live Text flat read merged in — unconditional by design; see
    // verticalRemainder. Cost is one LT pass per CHANGED frame only (an
    // unchanged page never reaches recognition), and a forced
    // --engine vision keeps meaning Vision alone.
    let mergedFrom = lines.count
    if raw == nil, reflow == nil, !vertical, orientation == .horizontal,
       engineMode == .auto {
        let extra = await verticalRemainder(subject, horizontal: lines)
        if !extra.isEmpty {
            let note = "mixed: merged \(extra.count) vertical line(s) into a "
                + "horizontal page\n"
            if note != lastMixedNote {
                lastMixedNote = note
                FileHandle.standardError.write(note.data(using: .utf8)!)
            }
            lines.append(contentsOf: extra)
        }
    }

    // Re-flowed page: a recognised line corresponds to one source column.
    if let rf = reflow, let g = geometry {
        let r = g.region
        let W = Double(image.width), H = Double(image.height)
        var out: [Line] = []
        // Order strip rows top-to-bottom so row index matches column index.
        // The recognizer often splits one strip row into several lines. They
        // all belong to the same source column, so gather them per row and
        // join in x order — otherwise one column emits several overlapping
        // lines, each starting from cell 0.
        let rowH = Double(subject.height) / Double(max(1, rf.rows.count))
        let stripW = Double(subject.width)
        let pitch = Double(rf.cell + rf.pad)

        // Which source cell a recognised character came from is decided by
        // WHERE it sits in the strip, not by its index in the string. The
        // recognizer drops and merges the odd character; an index-based
        // mapping shifts every glyph after the first discrepancy onto the
        // wrong cell, which is exactly what pinned placement at 1% while
        // coverage was already 77%.
        var byRow: [Int: [(Int, String)]] = [:]
        for l in lines {
            let row = min(max(0, Int((l.box.midY * Double(subject.height)) / rowH)),
                          rf.rows.count - 1)
            for c in l.chars {
                if c.ch.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                let midX = c.box.midX * stripW
                let cellIdx = Int(((midX - Double(rf.pad)) / pitch).rounded())
                byRow[row, default: []].append((cellIdx, c.ch))
            }
        }

        for row in byRow.keys.sorted() {
            let cells = rf.rows[row]
            let placedGlyphs = byRow[row]!.sorted { $0.0 < $1.0 }
                .filter { $0.0 >= 0 && $0.0 < cells.count }
            guard !placedGlyphs.isEmpty else { continue }
            let text = placedGlyphs.map(\.1).joined()
            // Reflowed lines ARE source columns, by construction.
            var line = Line(text: text, box: .zero, vertical: true)
            for (cellIdx, ch) in placedGlyphs {
                let c = cells[cellIdx].rect
                // Cell pixels -> normalised -> screen -> window-local.
                let nx = Double(c.minX) / W, ny = Double(c.minY) / H
                let nw = Double(c.width) / W, nh = Double(c.height) / H
                line.chars.append(
                    CharBox(ch: ch,
                            x: r.minX + nx * r.width - g.window.minX,
                            y: r.minY + ny * r.height - g.window.minY,
                            w: nw * r.width, h: nh * r.height))
            }
            if !line.chars.isEmpty { out.append(line) }
        }
        return out
    }

    // Column x for reading order, from the CHARACTER quads: LT's vertical
    // line boxes are unreliable (adjacent kakuyomu columns came back swapped
    // when sorted by line midX; the char quads are the ones placing at 89%).
    func colX(_ l: LiveText.RLine) -> Double {
        guard !l.chars.isEmpty else { return l.box.midX }
        return l.chars.reduce(0.0) { $0 + $1.box.midX } / Double(l.chars.count)
    }
    var flat = lines.enumerated().compactMap { pair -> (line: Line, colX: Double)? in
        let (idx, l) = (pair.offset, pair.element)
        let t = l.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }

        // Line.box stays bottom-left normalized: order() sorts with it. Its
        // midX is pinned to the char-quad column x so order()'s vertical sort
        // agrees with the pre-sort below (LT line boxes alone misorder).
        var line = Line(text: t,
                        box: CGRect(x: colX(l) - l.box.width / 2, y: 1 - l.box.maxY,
                                    width: l.box.width, height: l.box.height))

        // Per-line orientation. A forced/rotated vertical read is columns by
        // definition, as is anything the mixed-content merge appended. Any
        // OTHER Live Text flat read (native vertical page, or a probe pass
        // over a mixed page) is judged line by line on its own char-quad
        // spread — taller than wide, in pixels — because such reads carry
        // both orientations in one pass. A single-char line has no spread
        // and follows the page majority. Vision flat reads are horizontal
        // by construction (it reads nothing else).
        if vertical || idx >= mergedFrom {
            line.vertical = true
        } else if raw != nil {
            if l.chars.count >= 2 {
                let sw = Double(subject.width), sh = Double(subject.height)
                let xs = l.chars.map { $0.box.midX * sw }
                let ys = l.chars.map { $0.box.midY * sh }
                line.vertical = (ys.max()! - ys.min()!) > (xs.max()! - xs.min()!)
            } else {
                line.vertical = flatReadNativeVertical
            }
        }

        // Per-character rectangles, so the overlay can place one invisible span
        // per glyph and hit-test exactly what the eye is pointing at.
        if let g = geometry {
            let r = g.region
            for c in l.chars {
                // Normalised (top-left) -> screen -> window-local, which is
                // what the overlay positions its spans with.
                let screenX = r.minX + c.box.minX * r.width
                let screenY = r.minY + c.box.minY * r.height
                line.chars.append(
                    CharBox(
                        ch: c.ch,
                        x: screenX - g.window.minX,
                        y: screenY - g.window.minY,
                        w: c.box.width * r.width,
                        h: c.box.height * r.height))
            }
        }
        return (line, colX(l))
    }
    // A native vertical read arrives in Live Text's own line order (leftmost
    // column first, measured). Columns read right-to-left; emit them that
    // way, matching the reflow path's "lines arrive in reading order".
    if flatReadNativeVertical {
        flat.sort { $0.colX > $1.colX }
    }
    var result = flat.map(\.line)
    if flatReadNativeVertical, let g = geometry {
        reanchorVerticalChars(&result, image: subject, geometry: g)
    }
    // Attach erased-band ruby as reading hints to the line directly below
    // each band.
    if !hintBands.isEmpty, let g = geometry {
        let r = g.region
        let H = Double(subject.height)
        for hb in hintBands {
            let bandBottom = Double(hb.rect.maxY) / H * r.height
                + r.minY - g.window.minY
            let bandH = Double(hb.rect.height) / H * r.height
            var best = -1
            var bestD = Double.infinity
            for (i, line) in result.enumerated() {
                guard let top = line.chars.map(\.y).min() else { continue }
                // The base line's quads may overlap the erased band (engines
                // box generously); allow up to one band height of overlap.
                let d = top - bandBottom
                if d > -bandH, d < bestD { bestD = d; best = i }
            }
            if best >= 0, bestD < bandH * 2.5 {
                result[best].hint = (result[best].hint ?? "") + hb.text
            }
        }
    }
    return result
}

var lastLoggedEngine = ""
func logEngineOnce(_ name: String) {
    guard name != lastLoggedEngine else { return }
    lastLoggedEngine = name
    FileHandle.standardError.write("engine: \(name)\n".data(using: .utf8)!)
}

/// CJK symbols, kana, ideographs and full-width forms — what a tategaki
/// column is made of; used by the one-character-per-line artifact check.
func isCJK(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x3000...0x303F, 0x3040...0x309F, 0x30A0...0x30FF,
         0x4E00...0x9FFF, 0xFF00...0xFFEF:
        return true
    default: return false
    }
}

/// The Vision path, normalized to the shared intermediate shape (top-left
/// normalized boxes, one entry per character).
func visionLines(_ subject: CGImage, unrotate: Bool, wantChars: Bool)
        throws -> [LiveText.RLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.recognitionLevel = .accurate
    // Language correction rewrites Japanese badly (it assumes word-delimited
    // text); off gives cleaner raw output for dictionary lookup.
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: subject, options: [:])
    try handler.perform([request])
    guard let observations = request.results else { return [] }

    var out: [LiveText.RLine] = []
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let s = top.string
        var chars: [LiveText.Char] = []
        if wantChars {
            for idx in s.indices {
                let chStr = String(s[idx])
                if chStr.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                guard let q = try? top.boundingBox(for: idx..<s.index(after: idx))
                else { continue }
                // boundingBox(for:) returns a quad; use its axis-aligned bounds.
                var n = NBox(vision: q.boundingBox)
                if unrotate { n = n.unrotatedCCW }
                chars.append(LiveText.Char(
                    ch: chStr,
                    box: CGRect(x: n.x, y: n.y, width: n.w, height: n.h)))
            }
        }
        let lb = NBox(vision: obs.boundingBox)
        out.append(LiveText.RLine(
            text: s,
            box: CGRect(x: lb.x, y: lb.y, width: lb.w, height: lb.h),
            chars: chars))
    }
    return out
}

func order(_ lines: [Line], vertical: Bool) -> [String] {
    let sorted: [Line]
    if vertical {
        // Tategaki: columns run right-to-left, characters top-to-bottom.
        sorted = lines.sorted { a, b in
            let ax = a.box.midX, bx = b.box.midX
            if abs(ax - bx) > 0.04 { return ax > bx }
            return a.box.midY > b.box.midY
        }
    } else {
        // Yokogaki: lines top-to-bottom, then left-to-right.
        sorted = lines.sorted { a, b in
            let ay = a.box.midY, by = b.box.midY
            if abs(ay - by) > 0.015 { return ay > by }
            return a.box.midX < b.box.midX
        }
    }
    return sorted.map(\.text)
}

// MARK: - Crop command channel (INTEGRATION.md Phase 3)
//
// The overlay's Tier-2 path needs pixels for the region under the cursor.
// Re-capturing would need a second SCK session — concurrent sessions stall
// (measured; see CONVENTIONS) — so the watch process serves crops of its own
// LAST captured frame. Protocol: one line on stdin,
//     crop <id> <x> <y> <w> <h> <path>
// with x/y/w/h in frame-relative points (the same space as emitted char
// boxes). The crop is upscaled 2x (the accurate tier reads small regions
// better big) and written to <path>; the reply
//     {"crop":{"id":N,"path":"...","ok":true}}
// is emitted from the MAIN loop, never the reader thread — a stdout write
// from another thread can interleave with a multi-KB payload line and
// corrupt the NDJSON stream.
final class CropChannel {
    struct Req { let id: Int; let rect: CGRect; let path: String }
    private let lock = NSLock()
    private var pending: [Req] = []
    private var lastImage: CGImage?
    private var lastRegion: CGRect = .zero

    func startReader() {
        let t = Thread {
            while let line = readLine(strippingNewline: true) {
                let p = line.split(separator: " ")
                guard p.count == 7, p[0] == "crop",
                      let id = Int(p[1]), let x = Double(p[2]), let y = Double(p[3]),
                      let w = Double(p[4]), let h = Double(p[5]) else { continue }
                self.lock.lock()
                self.pending.append(Req(id: id,
                                        rect: CGRect(x: x, y: y, width: w, height: h),
                                        path: String(p[6])))
                self.lock.unlock()
            }
        }
        t.name = "crop-stdin"
        t.start()
    }

    func store(_ image: CGImage, region: CGRect) {
        lock.lock(); lastImage = image; lastRegion = region; lock.unlock()
    }

    /// Serve queued requests. Called once per watch pass on the main loop.
    func drain() {
        lock.lock()
        let reqs = pending; pending = []
        let img = lastImage; let region = lastRegion
        lock.unlock()
        guard !reqs.isEmpty else { return }
        for r in reqs {
            var ok = false
            if let img, region.width > 0 {
                // Frame points -> capture pixels (Retina: image is 2x region).
                let sx = Double(img.width) / region.width
                let sy = Double(img.height) / region.height
                let px = CGRect(x: r.rect.minX * sx, y: r.rect.minY * sy,
                                width: r.rect.width * sx, height: r.rect.height * sy)
                    .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
                if !px.isEmpty, let crop = img.cropping(to: px),
                   let up = upscale2x(crop) {
                    dumpImage(up, to: r.path)
                    ok = true
                }
            }
            print("{\"crop\":{\"id\":\(r.id),\"path\":\"\(jsonEscape(r.path))\",\"ok\":\(ok)}}")
            fflush(stdout)
        }
    }
}
let cropChannel = CropChannel()

/// Plain 2x bilinear upscale via CGContext.
func upscale2x(_ image: CGImage) -> CGImage? {
    let w = image.width * 2, h = image.height * 2
    guard let space = image.colorSpace,
          let ctx = CGContext(data: nil, width: w, height: h,
                              bitsPerComponent: image.bitsPerComponent,
                              bytesPerRow: 0, space: space,
                              bitmapInfo: image.bitmapInfo.rawValue)
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

// MARK: - Native-vertical re-anchoring (Phase 5 seed)

/// Replace Live Text's per-char geometry on native-vertical pages with
/// measured ink cells. Measured against a known render grid: LT quads on
/// dense columns come back ~1.7x the true pitch and drift up to two rows by
/// mid-column — text right, geometry wrong — which misplaces spans AND feeds
/// Tier-2 crops containing the neighbor character.
///
/// The circularity trap, paid for in three failed designs: any per-LINE crop
/// or alignment derived FROM the quads re-derives their drift (nearest-cell
/// and monotonic DTW both did, measured). So columns come from page-level
/// ink only; an LT line maps to its column by mean x (the one reliable quad
/// axis), a column's lines partition its cells in reading order, and cells
/// assign by pure index — but ONLY when the column's char count equals its
/// cell count. Any mismatch keeps the quads: degrade, don't guess.
func reanchorVerticalChars(_ lines: inout [Line], image: CGImage, geometry: Geometry) {
    let r = geometry.region
    let W = Double(image.width), H = Double(image.height)
    guard r.width > 0, r.height > 0 else { return }
    let columns = tategakiCells(image)
    guard !columns.isEmpty else { return }
    func toWin(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX / W * r.width + r.minX - geometry.window.minX,
               y: rect.minY / H * r.height + r.minY - geometry.window.minY,
               width: rect.width / W * r.width,
               height: rect.height / H * r.height)
    }
    struct ColRef { let x0: Double; let x1: Double; let cells: [CGRect] }
    let cols: [ColRef] = columns.map { col in
        let rects = col.map { toWin($0.rect) }.sorted { $0.minY < $1.minY }
        return ColRef(x0: Double(rects.map(\.minX).min() ?? 0),
                      x1: Double(rects.map(\.maxX).max() ?? 0),
                      cells: rects)
    }
    var byCol: [Int: [Int]] = [:]
    for li in lines.indices {
        let chars = lines[li].chars
        guard !chars.isEmpty else { continue }
        let mx = chars.map { $0.x + $0.w / 2 }.reduce(0, +) / Double(chars.count)
        if let ci = cols.firstIndex(where: { mx >= $0.x0 - 2 && mx <= $0.x1 + 2 }) {
            byCol[ci, default: []].append(li)
        }
    }
    for (ci, lis) in byCol {
        let col = cols[ci]
        // A column read as several LT lines partitions its cells top to
        // bottom; order the lines by their first quad.
        let ordered = lis.sorted {
            (lines[$0].chars.first?.y ?? 0) < (lines[$1].chars.first?.y ?? 0)
        }
        let total = ordered.reduce(0) { $0 + lines[$1].chars.count }
        // Repair marginal splitter decisions toward the recognizer's char
        // count (measured off by ±1–2 per column: an intra-glyph gap right
        // at the 0.45em boundary, e.g. 二 at 18px). The em cap keeps this
        // honest — merging across a real char boundary needs ~2em and is
        // refused, so a column where Live Text itself dropped or merged a
        // character still falls through to keep its quads.
        var cells = col.cells
        let em = col.x1 - col.x0
        var attempts = 0
        while cells.count != total && attempts < 3 {
            attempts += 1
            if cells.count > total {
                var best = -1
                var bestH = Double.infinity
                for i in 0..<(cells.count - 1) {
                    let h = Double(cells[i + 1].maxY - cells[i].minY)
                    if h < bestH { bestH = h; best = i }
                }
                guard best >= 0, bestH <= em * 1.15 else { break }
                let merged = cells[best].union(cells[best + 1])
                cells.replaceSubrange(best...(best + 1), with: [merged])
            } else {
                guard let tall = cells.indices.max(by: { cells[$0].height < cells[$1].height }),
                      Double(cells[tall].height) >= em * 1.4 else { break }
                let c = cells[tall]
                let top = CGRect(x: c.minX, y: c.minY, width: c.width, height: c.height / 2)
                let bot = CGRect(x: c.minX, y: c.midY, width: c.width, height: c.height / 2)
                cells.replaceSubrange(tall...tall, with: [top, bot])
            }
        }
        guard total == cells.count else { continue }
        var k = 0
        for li in ordered {
            for idx in lines[li].chars.indices {
                let c = cells[k]
                k += 1
                lines[li].chars[idx].x = c.minX
                lines[li].chars[idx].y = c.minY
                lines[li].chars[idx].w = c.width
                lines[li].chars[idx].h = c.height
            }
        }
    }
}

// MARK: - Furigana (INTEGRATION.md Phase 4)

/// Erase furigana from a horizontal page BEFORE recognition (Phase 4b).
///
/// Measured on a real Kindle page: BOTH engines fuse tightly-set ruby into
/// the base line and hallucinate characters — 別天神+ことあまつかみ came back
/// as 前実 (Live Text) and 前笑雑 (Vision), with the width error smeared
/// down the whole line as a cumulative glyph shift. Post-recognition line
/// filtering cannot fix what the recognizer already fused, so the ruby ink
/// is removed from the pixels first — the removal-before-recognition design
/// the research measured at +5% CER on Manga109.
///
/// Bands come from a pixel-resolution row projection: a band 30–65% the
/// height of the band directly below it, sitting within 0.8 of that band's
/// height, is a CANDIDATE. Geometry alone is not enough: a magazine page's
/// small body line directly above a large decorated section header fits the
/// same ratio, and erasing it made that line permanently unrecognizable
/// (measured on a mythology-reference page: the paragraph line above the
/// 神世七代 banner vanished from every pass). The caller reads each
/// candidate's text and only erases kana-dominant bands — furigana is kana
/// by definition; a body line is not.
func detectRubyBands(_ image: CGImage) -> [CGRect] {
    guard let m = inkMask(image, step: 1) else { return [] }
    // Per-SLICE row projection, not page-wide: sidebars, banners and border
    // art put ink on every row of a full-width projection and no band gap
    // survives (measured on the Kindle page — zero bands found). A slice is
    // wide enough for a ruby run, narrow enough that graphics only poison
    // their own slice.
    let slices = 6
    let sliceW = m.w / slices
    guard sliceW > 16 else { return [] }
    var ruby: [CGRect] = []
    for s in 0..<slices {
        let xs0 = s * sliceW, xs1 = min((s + 1) * sliceW, m.w) - 1
        var rowInk = [Int](repeating: 0, count: m.h)
        for y in 0..<m.h {
            var n = 0
            for x in xs0...xs1 where m.ink[y * m.w + x] { n += 1 }
            rowInk[y] = n
        }
        let bands = runs(rowInk, minInk: 1, minGap: 2)
        guard bands.count >= 2 else { continue }
        for i in 0..<(bands.count - 1) {
            let h0 = Double(bands[i].1 - bands[i].0 + 1)
            let h1 = Double(bands[i + 1].1 - bands[i + 1].0 + 1)
            let gap = Double(bands[i + 1].0 - bands[i].1)
            if h0 >= 6, h0 >= 0.30 * h1, h0 <= 0.65 * h1, gap < h1 * 0.8 {
                // Pad the erase: antialiased residue rows above/below the
                // detected band still made the engine fuse 天神 into 業
                // (measured). Down to 2px short of the base band; 4px up.
                let top = Double(bands[i].0) - 4
                let bottom = Double(bands[i + 1].0) - 2
                ruby.append(CGRect(x: Double(xs0), y: top,
                                   width: Double(xs1 - xs0 + 1),
                                   height: bottom - top))
            }
        }
    }
    return ruby
}

/// White-fill the given bands. Split from detection so the caller can vet
/// each candidate's TEXT between the two steps.
func eraseBands(_ image: CGImage, _ bands: [CGRect]) -> CGImage? {
    guard !bands.isEmpty else { return nil }
    // A fixed RGBA format, NOT the source's: PNG-loaded pages are alpha-less
    // 24-bit RGB, which CGBitmapContext refuses — the erase silently never
    // happened while the band detection worked (measured: bands printed,
    // recognition unchanged).
    guard let ctx = CGContext(data: nil, width: image.width, height: image.height,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    for b in bands {
        // CGContext origin is bottom-left; band rects are top-left.
        ctx.fill(CGRect(x: b.minX, y: Double(image.height) - b.maxY,
                        width: b.width, height: b.height))
    }
    return ctx.makeImage()
}

/// Fraction of a band's recognised characters that are kana (ー included —
/// long vowels appear in katakana readings). Furigana reads as nearly all
/// kana; a swallowed body line reads kanji-heavy. 0.7, not markRuby's 0.8:
/// band crops are small and Vision misreads the odd kana as a lookalike
/// kanji, which must not un-ruby a genuine reading.
func kanaFraction(_ s: String) -> Double {
    func isKana(_ u: Unicode.Scalar) -> Bool {
        (0x3041...0x309F).contains(u.value)      // hiragana
            || (0x30A1...0x30FA).contains(u.value)   // katakana letters
            || u.value == 0x30FC                     // ー
    }
    func isKanji(_ u: Unicode.Scalar) -> Bool {
        (0x4E00...0x9FFF).contains(u.value)
    }
    // Letters only — 、。「」 and ASCII say nothing about ruby-ness.
    let letters = s.unicodeScalars.filter { isKana($0) || isKanji($0) }
    guard !letters.isEmpty else { return 0 }
    return Double(letters.filter(isKana).count) / Double(letters.count)
}

/// Mark ruby lines: small kana lines sitting beside their base line.
///
/// Conditional by design — measured on Manga109, blanket removal REGRESSES
/// on sparse-furigana pages (−0.3%), and an over-aggressive filter is a known
/// way to suppress an entire overlay. Guards, all required at once:
///   - the page is height-bimodal (a genuinely small tier exists);
///   - the candidate is ≥80% kana (furigana are readings, not words);
///   - its glyph height is 35–65% of an adjacent base line's;
///   - it sits WHERE ruby sits: above the base (horizontal) or to its
///     right (vertical), within ~1.2 small-heights, overlapping ≥40%.
/// Marked lines also donate their text to the base line's `hint`.
func markRuby(_ lines: inout [Line], vertical: Bool) {
    guard lines.count >= 2 else { return }
    func h(_ l: Line) -> Double {
        let hs = l.chars.map(\.h).sorted()
        return hs.isEmpty ? 0 : hs[hs.count / 2]
    }
    func kanaFraction(_ s: String) -> Double {
        let ks = s.unicodeScalars.filter { !$0.properties.isWhitespace }
        guard !ks.isEmpty else { return 0 }
        let kana = ks.filter { (0x3040...0x30FF).contains($0.value) }.count
        return Double(kana) / Double(ks.count)
    }
    func bounds(_ l: Line) -> CGRect {
        var r = CGRect.null
        for c in l.chars {
            r = r.union(CGRect(x: c.x, y: c.y, width: c.w, height: c.h))
        }
        return r
    }
    let heights = lines.map(h).filter { $0 > 0 }
    guard let maxH = heights.max(), maxH > 0 else { return }
    // Bimodal gate: some line is at most 65% of the tallest text. NOT a
    // quartile — on furigana-dense pages ruby lines OUTNUMBER base lines,
    // and any percentile can land inside the small tier (measured: 3 ruby +
    // 1 base line put the quartile at ruby height and nothing matched).
    guard heights.contains(where: { $0 < maxH * 0.65 }) else { return }

    let boxes = lines.map(bounds)
    let hs = lines.map(h)
    for i in lines.indices {
        let small = boxes[i], smallH = hs[i]
        guard smallH > 0, !small.isNull,
              kanaFraction(lines[i].text) >= 0.8 else { continue }
        for j in lines.indices where j != i {
            let base = boxes[j], baseH = hs[j]
            guard baseH > 0, !base.isNull,
                  smallH >= baseH * 0.35, smallH <= baseH * 0.65 else { continue }
            let overlap: Double
            let gapOK: Bool
            if vertical {
                // Ruby runs down the RIGHT side of its column.
                let ov = min(small.maxY, base.maxY) - max(small.minY, base.minY)
                overlap = ov / max(1, small.height)
                let gap = small.minX - base.maxX
                gapOK = gap > -smallH * 0.5 && gap < smallH * 1.2
            } else {
                // Ruby sits ABOVE its base line.
                let ov = min(small.maxX, base.maxX) - max(small.minX, base.minX)
                overlap = ov / max(1, small.width)
                let gap = base.minY - small.maxY
                gapOK = gap > -smallH * 0.5 && gap < smallH * 1.2
            }
            if overlap >= 0.4 && gapOK {
                lines[i].ruby = true
                lines[j].hint = (lines[j].hint ?? "") + lines[i].text
                break
            }
        }
    }
}

// MARK: - Temporal voting (INTEGRATION.md Phase 2)

/// Majority vote across re-OCR passes of a STATIC page (frame hash unchanged).
/// Recognition noise is per-pass random while the pixels are constant — the
/// same page measured as 80 lines one pass and 77 the next — so the mode of
/// 2-3 reads beats any single read, and the agreement fraction becomes the
/// per-character confidence no engine supplies.
///
/// The FIRST pass is the base layout: the overlay built its spans from it, so
/// voted payloads keep line/char indices stable and the renderer can correct
/// text in place instead of rebuilding under the cursor. Later passes are
/// matched to base characters by GEOMETRY (nearest center within half a glyph),
/// never by string index — the same rule the strip mapping was paid for.
func voteLines(_ passes: [[Line]]) -> [Line] {
    guard passes.count > 1, let base = passes.first else { return passes.first ?? [] }
    struct BKey: Hashable { let x: Int; let y: Int }
    let cell = 32.0
    var grids: [[BKey: [CharBox]]] = []
    for pass in passes {
        var g: [BKey: [CharBox]] = [:]
        for l in pass {
            for c in l.chars {
                let k = BKey(x: Int((c.x + c.w / 2) / cell),
                             y: Int((c.y + c.h / 2) / cell))
                g[k, default: []].append(c)
            }
        }
        grids.append(g)
    }
    func nearest(_ g: [BKey: [CharBox]], _ cx: Double, _ cy: Double,
                 _ tol: Double) -> CharBox? {
        let bx = Int(cx / cell), by = Int(cy / cell)
        var best: CharBox? = nil
        var bestD = tol
        for dx in -1...1 {
            for dy in -1...1 {
                for c in g[BKey(x: bx + dx, y: by + dy)] ?? [] {
                    let d = max(abs(c.x + c.w / 2 - cx), abs(c.y + c.h / 2 - cy))
                    if d < bestD { bestD = d; best = c }
                }
            }
        }
        return best
    }
    let n = Double(passes.count)
    return base.map { line in
        var out = line
        out.chars = line.chars.map { c in
            let cx = c.x + c.w / 2, cy = c.y + c.h / 2
            let tol = max(6.0, 0.5 * max(c.w, c.h))
            var votes: [String: Int] = [:]
            for g in grids {
                if let m = nearest(g, cx, cy, tol) { votes[m.ch, default: 0] += 1 }
            }
            var v = c
            let baseCount = votes[c.ch] ?? 1
            // Ties go to the base character — it is what the DOM shows.
            if let (w, cnt) = votes.max(by: { $0.value < $1.value }), cnt > baseCount {
                v.ch = w
                v.conf = Double(cnt) / n
            } else {
                v.conf = Double(baseCount) / n
            }
            return v
        }
        out.text = out.chars.map(\.ch).joined()
        return out
    }
}

/// The parts of `f` another window is currently drawn over, expressed in the
/// same frame-local points as the glyph boxes.
///
/// Shipped with every payload AND every heartbeat: a window can be covered or
/// uncovered without one pixel of the target changing, and the consumer must
/// stop hit-testing glyphs the user cannot see the moment that happens.
func coversJSON(frame f: CGRect) -> String {
    let items = lastOccluders.compactMap { r -> String? in
        let hit = r.intersection(f)
        guard !hit.isNull, hit.width > 1, hit.height > 1 else { return nil }
        let pos = "\"x\":\(Int((hit.minX - f.minX).rounded(.down))),"
            + "\"y\":\(Int((hit.minY - f.minY).rounded(.down)))"
        let size = "\"w\":\(Int(hit.width.rounded(.up))),\"h\":\(Int(hit.height.rounded(.up)))"
        return "{" + pos + "," + size + "}"
    }
    return "[\(items.joined(separator: ","))]"
}

/// "The target has no window I can see." Not silence: the consumer needs to
/// tell this apart from a wedged watcher, and it is what tells the overlay to
/// get off the screen.
func emitIdle(json: Bool) {
    guard json else { return }
    print("{\"idle\":true}")
    fflush(stdout)
}

/// The gap between passes, spent watching the window we just captured instead
/// of sleeping through it.
///
/// The overlay panel is on every Space, so from the moment you swipe to
/// another desktop it is drawn over whatever is there — glyph layer, popup and
/// all — until this process says the target is gone. Saying it only at the top
/// of the next pass meant riding along for one full period: measured 0.7s
/// between heartbeats, 1.3s when the pass includes an OCR read. The check is
/// CGWindowList only (~1ms), so it can run every 150ms for free.
func waitNextPass(_ interval: Double, watching id: CGWindowID?, json: Bool) async {
    var left = interval
    repeat {
        let step = min(0.15, left)
        try? await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
        left -= step
        if let id, !stillVisible(id) { emitIdle(json: json); return }
    } while left > 0
}

/// The every-pass "still here, nothing new" line. Carries the frame origin and
/// the cover regions, because both move while the recognised text does not.
func heartbeatJSON(frame f: CGRect) -> String {
    let frameJson = "{\"x\":\(Int(f.origin.x)),\"y\":\(Int(f.origin.y)),"
        + "\"width\":\(Int(f.width)),\"height\":\(Int(f.height))}"
    return "{\"frame\":\(frameJson),\"covers\":\(coversJSON(frame: f)),\"unchanged\":true}"
}

/// The watch payload. `vote` counts the passes behind this text (1 = single
/// read); the renderer uses it to update voted corrections in place. `f` per
/// char is the voting confidence, present only after a vote.
func buildPayload(_ lines: [Line], frame f: CGRect, window w: CGRect,
                  vertical: Bool, vote: Int) -> String {
    var parts: [String] = []
    for l in lines where !l.chars.isEmpty {
        let cs = l.chars.map { c -> String in
            let geo = "\"x\":\(Int(c.x)),\"y\":\(Int(c.y)),"
                + "\"w\":\(Int(c.w.rounded(.up))),\"h\":\(Int(c.h.rounded(.up)))"
            var s = "{\"c\":\"\(jsonEscape(c.ch))\"," + geo
            if let conf = c.conf { s += ",\"f\":\(String(format: "%.2f", conf))" }
            return s + "}"
        }.joined(separator: ",")
        var lineJson = "{\"text\":\"\(jsonEscape(l.text))\""
        if l.ruby { lineJson += ",\"ruby\":true" }
        if l.vertical { lineJson += ",\"vertical\":true" }
        if let hint = l.hint { lineJson += ",\"hint\":\"\(jsonEscape(hint))\"" }
        lineJson += ",\"chars\":[\(cs)]}"
        parts.append(lineJson)
    }
    // Long interpolations split into locals: the type-checker has timed out
    // on big concatenations twice before.
    let frameJson = "{\"x\":\(Int(f.origin.x)),\"y\":\(Int(f.origin.y)),"
        + "\"width\":\(Int(f.width)),\"height\":\(Int(f.height))}"
    let windowJson = "{\"x\":\(Int(w.origin.x)),\"y\":\(Int(w.origin.y)),"
        + "\"width\":\(Int(w.width)),\"height\":\(Int(w.height))}"
    let head = "{\"frame\":\(frameJson),\"covers\":\(coversJSON(frame: f)),"
        + "\"window\":\(windowJson),"
    let meta = "\"vertical\":\(vertical),\"engine\":\"\(lastLoggedEngine)\",\"vote\":\(vote),"
    return head + meta + "\"lines\":[\(parts.joined(separator: ","))]}"
}

func emit(_ text: String, to path: String?) {
    guard let path else {
        print(text)
        return
    }
    // replaceItemAt requires the destination to already exist, so a first write
    // to a fresh path would silently do nothing and strand the .tmp file.
    // Foundation's atomic write covers that case on its own.
    guard FileManager.default.fileExists(atPath: path) else {
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        return
    }
    let tmp = path + ".tmp"
    guard (try? text.write(toFile: tmp, atomically: true, encoding: .utf8)) != nil else {
        return
    }
    // Atomic replace so the web page never reads a half-written file.
    if (try? FileManager.default.replaceItemAt(
        URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))) == nil {
        try? FileManager.default.removeItem(atPath: tmp)
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

@main
struct Main {
    static func main() async {
        let opts = parseArgs()

        if opts.assumeHorizontal { orientation = .horizontal }

        // Establish a window-server connection. Without this a plain CLI
        // process has no CGS connection and the capture path aborts with
        // "Assertion failed: (did_initialize) ... CGS_REQUIRE_INIT".
        // .accessory keeps it off the Dock and out of the app switcher.
        let nsApp = NSApplication.shared
        nsApp.setActivationPolicy(.accessory)

        // These three need no ScreenCaptureKit call, and must run before one:
        // without Screen Recording permission SCShareableContent stalls for
        // seconds before failing, which made the settings picker look hung.
        if opts.checkPerm {
                // CGPreflight does not prompt; it just reports.
                let ok = CGPreflightScreenCaptureAccess()
                print("{\"screenRecording\":\(ok)}")
                exit(ok ? 0 : 3)
            }

        if let imgPath = opts.imagePath {
                // File mode: recognize a PNG from disk. Needs no permission and
                // no ScreenCaptureKit session, so it runs while the overlay is
                // up (a one-shot *capture* would stall on the concurrent SCK
                // session — this path deliberately never opens one).
                guard let src = CGImageSourceCreateWithURL(
                          URL(fileURLWithPath: imgPath) as CFURL, nil),
                      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
                    FileHandle.standardError.write(
                        "cannot read image: \(imgPath)\n".data(using: .utf8)!)
                    exit(1)
                }
                // Region == window == image bounds: normalised boxes scale
                // straight to pixel coordinates, origin top-left. There is no
                // screen involved, so pixels are the coordinate system.
                let bounds = CGRect(x: 0, y: 0,
                                    width: image.width, height: image.height)
                if opts.cellsDump {
                    let cols = tategakiCells(image)
                    let colJson = cols.map { col in
                        "[" + col.map { c in
                            "{\"x\":\(Int(c.rect.minX)),\"y\":\(Int(c.rect.minY)),"
                            + "\"w\":\(Int(c.rect.width)),\"h\":\(Int(c.rect.height))}"
                        }.joined(separator: ",") + "]"
                    }.joined(separator: ",")
                    print("{\"columns\":[\(colJson)]}")
                    exit(0)
                }
                let geom = Geometry(region: bounds, window: bounds)
                do {
                    var (lines, isVertical) = try await recognizeAuto(
                        image, geometry: geom, forced: opts.vertical)
                    markRuby(&lines, vertical: isVertical)
                    if opts.json {
                        emit(buildPayload(lines, frame: bounds, window: bounds,
                                          vertical: isVertical, vote: 1),
                             to: opts.outPath)
                    } else {
                        // Reflowed vertical lines are already in reading order
                        // (same rule as the capture path). Ruby lines are
                        // dropped from text output — readings are hints, not
                        // text.
                        let textLines = lines.filter { !$0.ruby }
                        let text = (orientation == .verticalNative
                        // Native-vertical lines are pre-sorted by their char
                        // quads; order()'s 0.04 column-tie threshold exceeds a
                        // dense page's column spacing (kakuyomu: 0.033) and
                        // re-swaps adjacent columns. Do not re-sort them.
                        ? textLines.map(\.text)
                        : order(textLines, vertical: opts.vertical && !isVertical))
                            .joined(separator: "\n")
                        emit(text, to: opts.outPath)
                    }
                } catch {
                    FileHandle.standardError.write(
                        "recognition failed: \(error)\n".data(using: .utf8)!)
                    exit(1)
                }
                exit(0)
            }

        if opts.events {
                streamEvents(modifier: opts.modifier)
                // Park the task forever. Sleeping keeps the main queue (and
                // therefore the run loop the monitors deliver on) draining,
                // without the run-loop calls that Swift 6 forbids in an async
                // context.
                while true {
                    try? await Task.sleep(nanoseconds: 3_600_000_000_000)
                }
                exit(0)
            }

        if opts.listAll {
                // CGWindowListCopyWindowInfo rather than SCShareableContent:
                // it returns in ~50ms and, crucially, still works without
                // Screen Recording permission (titles come back empty, but the
                // owning app and geometry are enough to pick a target). SCK
                // stalls for seconds before failing when permission is absent,
                // which made the settings picker look hung.
                // Not .optionOnScreenOnly: a target sitting on another Space
                // must still be pickable.
                let info = CGWindowListCopyWindowInfo(
                    [.optionAll, .excludeDesktopElements],
                    kCGNullWindowID) as? [[String: Any]] ?? []
                let onScreenIDs = Set((CGWindowListCopyWindowInfo(
                    [.optionOnScreenOnly, .excludeDesktopElements],
                    kCGNullWindowID) as? [[String: Any]] ?? [])
                    .compactMap { $0[kCGWindowNumber as String] as? Int })

                // Map owning pid -> bundle id, which CGWindowList does not give.
                var bundleFor: [pid_t: String] = [:]
                for a in NSWorkspace.shared.runningApplications {
                    if let b = a.bundleIdentifier { bundleFor[a.processIdentifier] = b }
                }

                var items: [String] = []
                for w in info {
                    // Bounds bridge as NSNumber, not CGFloat — casting the
                    // dictionary to [String: CGFloat] silently yields nil and
                    // drops every window.
                    guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                          let bounds = w[kCGWindowBounds as String] as? [String: Any],
                          let width = (bounds["Width"] as? NSNumber)?.doubleValue,
                          let height = (bounds["Height"] as? NSNumber)?.doubleValue,
                          width >= 300, height >= 200 else { continue }
                    let bid = bundleFor[pid] ?? ""
                    if bid.isEmpty || bid.hasPrefix("com.apple.dock") { continue }
                    let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
                    let title = w[kCGWindowName as String] as? String ?? ""
                    let wid = w[kCGWindowNumber as String] as? Int ?? 0
                    let ox = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
                    let oy = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
                    items.append("""
                        {"id":\(wid),"bundle":"\(jsonEscape(bid))",\
                        "app":"\(jsonEscape(owner))","title":"\(jsonEscape(title))",\
                        "x":\(Int(ox)),"y":\(Int(oy)),\
                        "width":\(Int(width)),"height":\(Int(height)),\
                        "onScreen":\(onScreenIDs.contains(wid))}
                        """)
                }
                print("[\(items.joined(separator: ","))]")
                exit(0)
            }

        do {
            let windows = try await targetWindows()

            if opts.debug {
                let all = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true)
                print("total shareable windows: \(all.windows.count)")
                for w in all.windows {
                    let app = w.owningApplication
                    let bid = app?.bundleIdentifier ?? "<nil>"
                    guard bid.lowercased().contains("amazon") || bid.lowercased().contains("kindle")
                        || (w.title ?? "").lowercased().contains("kindle") || w.frame.width > 400
                    else { continue }
                    print("  bundle=\(bid)")
                    print("    app=\(app?.applicationName ?? "?")  title=\(w.title ?? "<nil>")")
                    print("    frame=\(Int(w.frame.width))x\(Int(w.frame.height)) "
                        + "@\(Int(w.frame.origin.x)),\(Int(w.frame.origin.y)) "
                        + "onScreen=\(w.isOnScreen) layer=\(w.windowLayer) id=\(w.windowID)")
                }
                exit(0)
            }

            if opts.list {
                if windows.isEmpty {
                    print("no Kindle windows found")
                } else {
                    for w in windows {
                        let title = w.title ?? "(untitled)"
                        print("id=\(w.windowID)  \(Int(w.frame.width))x\(Int(w.frame.height))  \(title)")
                    }
                }
                exit(windows.isEmpty ? 1 : 0)
            }

            // Watch mode must not die here: launched before the target app
            // (or while it is still opening), exiting put the supervisor into
            // its restart backoff — measured up to 30s of dead overlay per
            // retry, in a loop, until the app happened to be up during a
            // spawn (/tmp/yomi-overlay.log 2026-08-10 08:50→08:57). The watch
            // loop re-resolves the window every pass anyway; let it wait.
            guard !windows.isEmpty || opts.watch else {
                FileHandle.standardError.write(
                    "No matching window found. Use --list-all to see candidates.\n"
                        .data(using: .utf8)!)
                exit(1)
            }
            if windows.isEmpty {
                FileHandle.standardError.write(
                    "target has no window yet — watching until one appears\n"
                        .data(using: .utf8)!)
            }

            if opts.frame {
                // Emit the Kindle window bounds as NDJSON so the overlay can
                // track it with one long-lived process instead of respawning.
                repeat {
                    if let w = (try? await chooseWindow()) ?? nil {
                        let f = w.frame
                        let title = (w.title ?? "").replacingOccurrences(of: "\"", with: "\\\"")
                        print("""
                            {"x":\(Int(f.origin.x)),"y":\(Int(f.origin.y)),\
                            "width":\(Int(f.width)),"height":\(Int(f.height)),\
                            "id":\(w.windowID),"title":"\(title)"}
                            """)
                        fflush(stdout)
                    } else {
                        print("{\"error\":\"no-window\"}")
                        fflush(stdout)
                    }
                    if opts.watch {
                        try await Task.sleep(nanoseconds: UInt64(opts.interval * 1_000_000_000))
                    }
                } while opts.watch
                exit(0)
            }

            var lastText = ""
            var failures = 0
            // The window the last pass captured, re-checked between passes so
            // a swipe to another Space is noticed in ~150ms instead of at the
            // top of the next pass.
            var lastWindowID: CGWindowID? = nil
            var lastHash: UInt64 = 0
            var lastFrame = CGRect.zero
            // Temporal-voting state for the current stable page (Phase 2).
            var voteBuf: [[Line]] = []
            var lastVertical = false
            var stablePasses = 0
            // Tier-2 crop requests arrive on stdin (Phase 3).
            if opts.json && opts.watch { cropChannel.startReader() }
            repeat {
                do {
                    // Re-resolve the window each pass so it survives resize/reopen,
                    // and so we never capture a stale or replaced window handle.
                    // try, not try?: a discovery stall must surface through the
                    // catch below ("capture failed (Nx, retrying)"), not be
                    // swallowed into the honest-absence path.
                    guard let current = try await chooseWindow() else {
                        // Every candidate is parked on another Space. Capturing
                        // one produces nothing usable, and — worse — its frame
                        // is parked outside the desktop too, so the overlay
                        // would chase the panel off screen and drag the glyph
                        // layer with it. No frame is emitted, so the consumer's
                        // idle timer still hides the overlay — but the marker
                        // below lets it tell "target off screen" apart from "a
                        // wedged watcher", which used to look identical
                        // (measured: 40 min of silence, 2026-08-09 20:14).
                        if opts.watch {
                            lastWindowID = nil
                            emitIdle(json: opts.json)
                            try await Task.sleep(
                                nanoseconds: UInt64(opts.interval * 1_000_000_000))
                            continue
                        }
                        FileHandle.standardError.write(
                            "target window is not on screen\n".data(using: .utf8)!)
                        exit(1)
                    }
                    lastWindowID = current.windowID
                    let shot = try await capture(window: current)
                    if let dp = opts.dumpPath {
                        dumpImage(shot.image, to: dp)
                        let px = "\(shot.image.width)x\(shot.image.height)px"
                        let rg = CGRect(origin: shot.origin, size: shot.size)
                        let wf = current.frame
                        let rs = "\(Int(rg.origin.x)),\(Int(rg.origin.y)) \(Int(rg.width))x\(Int(rg.height))"
                        let ws = "\(Int(wf.origin.x)),\(Int(wf.origin.y)) \(Int(wf.width))x\(Int(wf.height))"
                        let msg = "dumped \(px) region=\(rs) window=\(ws)\n"
                        FileHandle.standardError.write(msg.data(using: .utf8)!)
                    }

                    cropChannel.store(shot.image, region: shot.region)
                    cropChannel.drain()

                    // Skip the expensive recognition pass when neither the
                    // pixels nor the window geometry have changed.
                    let hash = frameHash(shot.image)
                    if hash == lastHash, current.frame == lastFrame, !lastText.isEmpty {
                        // Static page: the cheap moment to buy accuracy.
                        // Re-OCR every Nth unchanged pass, up to `votes`
                        // reads, and majority-vote per character. Every pass
                        // still emits payload-or-heartbeat — the heartbeat
                        // contract below is inviolable.
                        stablePasses += 1
                        if opts.json, opts.votes > 1, !voteBuf.isEmpty,
                           voteBuf.count < opts.votes,
                           stablePasses % opts.voteEvery == 0 {
                            let geom = Geometry(region: shot.region, window: shot.region)
                            let (pass, _) = try await recognizeAuto(
                                shot.image, geometry: geom, forced: opts.vertical)
                            // A transient bad read (empty, half the page) must
                            // not tank every char's confidence; skip it.
                            let baseN = voteBuf[0].reduce(0) { $0 + $1.chars.count }
                            let passN = pass.reduce(0) { $0 + $1.chars.count }
                            if passN * 2 >= baseN {
                                voteBuf.append(pass)
                                let voted = voteLines(voteBuf)
                                let f = CGRect(origin: shot.origin, size: shot.size)
                                let payload = buildPayload(
                                    voted, frame: f, window: current.frame,
                                    vertical: lastVertical, vote: voteBuf.count)
                                if payload != lastText {
                                    emit(payload, to: opts.outPath)
                                    lastText = payload
                                    if opts.outPath == nil { fflush(stdout) }
                                    FileHandle.standardError.write(
                                        "voted pass \(voteBuf.count)/\(opts.votes)\n"
                                            .data(using: .utf8)!)
                                    if opts.watch {
                                        await waitNextPass(opts.interval,
                                            watching: lastWindowID, json: opts.json)
                                    }
                                    continue
                                }
                                // Identical after voting — fall through to the
                                // heartbeat so this pass still emits.
                            }
                        }
                        // Heartbeat. The consumer needs to tell "page unchanged"
                        // apart from "target not on screen" — without this an
                        // unchanged page looks identical to a vanished window,
                        // and the overlay hides itself while you are reading.
                        if opts.json {
                            print(heartbeatJSON(frame: CGRect(origin: shot.origin,
                                                              size: shot.size)))
                            fflush(stdout)
                        }
                        if opts.watch {
                            await waitNextPass(opts.interval,
                                               watching: lastWindowID, json: opts.json)
                        }
                        continue
                    }
                    lastHash = hash
                    lastFrame = current.frame

                    // Positions are expressed against the captured region, not
                    // the window: a window's self-reported frame is stale while
                    // it is fullscreen, and anything derived from it inherits
                    // that error. The consumer places the layer at the region
                    // origin, so region-relative coordinates land exactly on
                    // the real glyphs whatever the window claims.
                    let geom = Geometry(region: shot.region, window: shot.region)
                    // Geometry is passed in text mode too: ruby detection
                    // needs char boxes (heights + adjacency).
                    var (lines, isVertical) = try await recognizeAuto(
                        shot.image, geometry: geom, forced: opts.vertical)
                    markRuby(&lines, vertical: isVertical)

                    // Fresh page: this read is vote 1 and the base layout the
                    // renderer will build spans from.
                    voteBuf = [lines]
                    lastVertical = isVertical
                    stablePasses = 0

                    if opts.json {
                        // NDJSON: one capture per line, with per-character boxes
                        // in window points (CSS-ready, origin top-left).
                        // "frame" is the coordinate origin the glyph boxes are
                        // relative to — the captured region. The window's own
                        // rect goes out separately, for diagnostics only.
                        let f = CGRect(origin: shot.origin, size: shot.size)
                        let payload = buildPayload(
                            lines, frame: f, window: current.frame,
                            vertical: isVertical, vote: 1)
                        let parts = lines.filter { !$0.chars.isEmpty }
                        if payload != lastText {
                            emit(payload, to: opts.outPath)
                            lastText = payload
                            if opts.outPath == nil { fflush(stdout) }
                            FileHandle.standardError.write(
                                "emitted \(parts.count) lines\n".data(using: .utf8)!)
                        } else {
                            // The pixels moved (the hash differed) but the
                            // recognised text and geometry did not — an
                            // animation, a caret, a video. Still a heartbeat:
                            // without one the consumer cannot tell this apart
                            // from a vanished window and hides the overlay
                            // mid-read.
                            print(heartbeatJSON(frame: f))
                            fflush(stdout)
                        }
                        if opts.watch {
                            await waitNextPass(opts.interval,
                                               watching: lastWindowID, json: opts.json)
                        }
                        continue
                    }

                    // Rotation already returns columns in reading order, so a
                    // detected-vertical page needs no re-sorting. Ruby lines
                    // are dropped from text output — that is the filter's
                    // whole point (readings are hints, not text).
                    let textLines = lines.filter { !$0.ruby }
                    let text = (orientation == .verticalNative
                        // Native-vertical lines are pre-sorted by their char
                        // quads; order()'s 0.04 column-tie threshold exceeds a
                        // dense page's column spacing (kakuyomu: 0.033) and
                        // re-swaps adjacent columns. Do not re-sort them.
                        ? textLines.map(\.text)
                        : order(textLines, vertical: opts.vertical && !isVertical))
                        .joined(separator: "\n")

                    if failures > 0 {
                        FileHandle.standardError.write(
                            "capture recovered after \(failures) failure(s)\n".data(using: .utf8)!)
                        failures = 0
                    }

                    if text != lastText {
                        emit(text, to: opts.outPath)
                        lastText = text
                        if opts.outPath != nil {
                            FileHandle.standardError.write(
                                "captured \(lines.count) lines\n".data(using: .utf8)!)
                        }
                    }
                } catch {
                    // In watch mode a failure is usually transient: the Kindle
                    // Space isn't composited while another desktop is active.
                    // Keep retrying instead of dying.
                    guard opts.watch else {
                        FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
                        exit(1)
                    }
                    failures += 1
                    if failures == 1 || failures % 10 == 0 {
                        FileHandle.standardError.write(
                            "capture failed (\(failures)x, retrying): \(error)\n"
                                .data(using: .utf8)!)
                    }
                }

                if opts.watch {
                    await waitNextPass(opts.interval,
                                       watching: lastWindowID, json: opts.json)
                }
            } while opts.watch

        } catch {
            FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
    }
}
