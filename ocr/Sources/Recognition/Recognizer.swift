// Recognition orchestration: reflow, furigana strip, engine dispatch, and
// the mapping of recognised boxes back onto the page.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

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
