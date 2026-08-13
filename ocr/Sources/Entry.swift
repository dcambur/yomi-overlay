// Argument parsing to command dispatch. The subcommands themselves
// live in CLI/.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

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
