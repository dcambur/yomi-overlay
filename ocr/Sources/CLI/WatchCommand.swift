// --watch: the capture loop. One pass per interval, emitting a payload,
// a heartbeat, or an idle marker — never nothing.

import CoreGraphics
import Foundation

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
        if let id, !stillVisible(id) {
            emitIdle(json: json)
            return
        }
    } while left > 0
}

/// How long to wait after a pass that produced NEW text, instead of the full
/// interval.
///
/// The frame a pass recognises is captured before the recognition runs, so by
/// the time the payload lands it describes pixels up to a whole pass old —
/// measured p50 2.2s of recognition on a real Kindle page. Someone who just
/// turned a page is often about to turn another, and re-capturing straight
/// away is what catches the second turn without waiting out an interval that
/// exists for idle pages.
///
/// Bounded, because a page that changes every pass would otherwise pin the
/// recogniser: after `maxSettlePasses` consecutive shortened waits the
/// ordinary interval comes back. Pixels that move while the TEXT does not
/// already fall outside this — that path emits a heartbeat, not new text.
let settleInterval = 0.1
let maxSettlePasses = 3

/// The watch loop. Re-resolves the target every pass so it survives a
/// resize, a reopen, or a move to another Space.
func runWatchLoop(_ opts: Options) async throws {
    // One session for the whole loop: orientation is sticky across passes,
    // which is the point of caching it at all.
    let session = RecognitionSession(opts)
    var lastText = ""
    var failures = 0
    // The window the last pass captured, re-checked between passes so
    // a swipe to another Space is noticed in ~150ms instead of at the
    // top of the next pass.
    var lastWindowID: CGWindowID? = nil
    var lastHash: UInt64 = 0
    var lastFrame = CGRect.zero
    var settlePasses = 0
    // Temporal-voting state for the current stable page (Phase 2).
    var voteBuf: [[Line]] = []
    var lastVertical = false
    var stablePasses = 0
    // Tier-2 crop requests arrive on stdin (Phase 3).
    if opts.json && opts.watch { cropChannel.startReader() }
    repeat {
        // Set below when this pass emitted text that differed, so the wait at
        // the end can tell a settling page from an idle one.
        var producedNewText = false
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
            let shot = try await capture(current)
            if let dp = opts.dumpPath {
                dumpImage(shot.image, to: dp)
                let px = "\(shot.image.width)x\(shot.image.height)px"
                let rg = CGRect(origin: shot.origin, size: shot.size)
                let wf = current.frame
                let rs =
                    "\(Int(rg.origin.x)),\(Int(rg.origin.y)) \(Int(rg.width))x\(Int(rg.height))"
                let ws =
                    "\(Int(wf.origin.x)),\(Int(wf.origin.y)) \(Int(wf.width))x\(Int(wf.height))"
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
                    stablePasses % opts.voteEvery == 0
                {
                    let geom = Geometry(region: shot.region, window: shot.region)
                    let (pass, _) = try await recognizeAuto(
                        shot.image, geometry: geom, forced: opts.vertical,
                        session: session)
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
                            vertical: lastVertical, vote: voteBuf.count,
                            engine: session.lastLoggedEngine)
                        if payload != lastText {
                            emit(payload, to: opts.outPath)
                            lastText = payload
                            if opts.outPath == nil { fflush(stdout) }
                            FileHandle.standardError.write(
                                "voted pass \(voteBuf.count)/\(opts.votes)\n"
                                    .data(using: .utf8)!)
                            if opts.watch {
                                await waitNextPass(
                                    opts.interval,
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
                    print(
                        heartbeatJSON(
                            frame: CGRect(
                                origin: shot.origin,
                                size: shot.size)))
                    fflush(stdout)
                }
                if opts.watch {
                    await waitNextPass(
                        opts.interval,
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
                shot.image, geometry: geom, forced: opts.vertical,
                session: session)
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
                    vertical: isVertical, vote: 1,
                    engine: session.lastLoggedEngine)
                let parts = lines.filter { !$0.chars.isEmpty }
                if payload != lastText {
                    emit(payload, to: opts.outPath)
                    lastText = payload
                    producedNewText = true
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
                    settlePasses =
                        producedNewText && settlePasses < maxSettlePasses
                        ? settlePasses + 1 : 0
                    await waitNextPass(
                        settlePasses > 0 ? settleInterval : opts.interval,
                        watching: lastWindowID, json: opts.json)
                }
                continue
            }

            // Rotation already returns columns in reading order, so a
            // detected-vertical page needs no re-sorting. Ruby lines
            // are dropped from text output — that is the filter's
            // whole point (readings are hints, not text).
            let textLines = lines.filter { !$0.ruby }
            let text =
                (session.orientation == .verticalNative
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
            // In watch mode a failure is usually transient: the target
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
            await waitNextPass(
                opts.interval,
                watching: lastWindowID, json: opts.json)
        }
    } while opts.watch
}
