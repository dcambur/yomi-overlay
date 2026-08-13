// Which way the page reads, decided by trying it, and the engine policy
// that follows from the answer.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

/// Which recognizer reads the pixels. `auto` prefers Live Text and degrades to
/// Vision when the private classes are missing or misbehave; `vision` is the
/// one-line revert (INTEGRATION.md Phase 1).
enum EngineMode: String { case auto, vision, livetext }

/// Which way the page's text runs. Sticky across passes: probing both
/// orientations costs a second Vision pass, which is the expensive step.
/// `verticalNative` is a vertical page Live Text reads directly, columns as
/// lines — no reflow (measured better than reflow: 99%/89% vs 94%/66%).
enum Orientation { case unknown, horizontal, vertical, verticalNative }

/// Set by recognize() when a flat Live Text read came back as native vertical
/// columns; recognizeAuto turns it into orientation + the payload flag.

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
func recognizeAuto(_ image: CGImage, geometry: Geometry?, forced: Bool,
                   session: RecognitionSession)
        async throws -> (lines: [Line], vertical: Bool) {
    func run(_ v: Bool) async throws -> [Line] {
        try await recognize(image, geometry: geometry, vertical: v, session: session)
    }
    func weight(_ ls: [Line]) -> Int { ls.reduce(0) { $0 + $1.text.count } }

    if forced {
        session.orientation = .vertical
        return (try await run(true), true)
    }
    switch session.orientation {
    case .horizontal:
        let h = try await run(false)
        if session.flatReadNativeVertical && weight(h) >= 5 {
            session.orientation = .verticalNative   // page turned into a vertical one
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
        session.orientation = .unknown          // stopped working — re-probe below
    case .verticalNative:
        let h = try await run(false)
        if session.flatReadNativeVertical && weight(h) >= 5 { return (h, true) }
        session.orientation = .unknown
    case .vertical:
        let v = try await run(true)
        if weight(v) >= 5 { return (v, true) }
        session.orientation = .unknown
    case .unknown:
        break
    }

    let h = try await run(false)
    // A native vertical read needs no second probe: it already carries true
    // page geometry, and the reflow alternative measures worse (89% vs 66%).
    if session.flatReadNativeVertical && weight(h) >= 5 {
        session.orientation = .verticalNative
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
        session.orientation = vertical ? .vertical : .horizontal
        let mode = vertical ? "vertical (tategaki)" : "horizontal"
        let note = "orientation: \(mode) (h=\(hw) v=\(weight(v)) chars)\n"
        FileHandle.standardError.write(note.data(using: .utf8)!)
    }
    // The probe ran with the furigana strip OFF (it must — stripping a
    // vertical page's h-probe mutilates columns). Now that the page is
    // committed horizontal, one re-read applies the strip if there is
    // anything to strip.
    if !vertical, session.orientation == .horizontal, !detectRubyBands(image).isEmpty {
        return (try await run(false), false)
    }
    return (vertical ? v : h, vertical)
}
