// Putting recognised boxes back on the page.
//
// Three mappers, split out of recognize(): one for the reflow strip, one for
// an ordinary flat read, and one that attaches erased ruby to the line it
// belongs to. Each was a block inside a 343-line function; none of the logic
// changed.

import CoreGraphics
import Foundation

/// Re-flowed page: a recognised line corresponds to one source column.
func mapReflowedStrip(
    _ lines: [RecognizedLine],
    reflow rf: (image: CGImage, rows: [[Cell]], cell: Int, pad: Int),
    image: CGImage, subject: CGImage,
    geometry g: Geometry
) -> [Line] {
    let r = g.region
    let W = Double(image.width)
    let H = Double(image.height)
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
        let row = min(
            max(0, Int((l.box.midY * Double(subject.height)) / rowH)),
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
            let nx = Double(c.minX) / W
            let ny = Double(c.minY) / H
            let nw = Double(c.width) / W
            let nh = Double(c.height) / H
            line.chars.append(
                CharBox(
                    ch: ch,
                    x: r.minX + nx * r.width - g.window.minX,
                    y: r.minY + ny * r.height - g.window.minY,
                    w: nw * r.width, h: nh * r.height))
        }
        if !line.chars.isEmpty { out.append(line) }
    }
    return out
}

/// An ordinary flat read: per-line orientation, per-character rectangles, and
/// the right-to-left re-sort a native vertical read needs.
func mapFlatLines(
    _ lines: [RecognizedLine], subject: CGImage,
    geometry: Geometry?, vertical: Bool, mergedFrom: Int,
    fromLiveText: Bool, session: RecognitionSession
) -> [Line] {
    // Column x for reading order, from the CHARACTER quads: LT's vertical
    // line boxes are unreliable (adjacent kakuyomu columns came back swapped
    // when sorted by line midX; the char quads are the ones placing at 89%).
    func colX(_ l: RecognizedLine) -> Double {
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
        var line = Line(
            text: t,
            box: CGRect(
                x: colX(l) - l.box.width / 2, y: 1 - l.box.maxY,
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
        } else if fromLiveText {
            if l.chars.count >= 2 {
                let sw = Double(subject.width)
                let sh = Double(subject.height)
                let xs = l.chars.map { $0.box.midX * sw }
                let ys = l.chars.map { $0.box.midY * sh }
                line.vertical = (ys.max()! - ys.min()!) > (xs.max()! - xs.min()!)
            } else {
                line.vertical = session.flatReadNativeVertical
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
    if session.flatReadNativeVertical {
        flat.sort { $0.colX > $1.colX }
    }
    var result = flat.map(\.line)
    if session.flatReadNativeVertical, let g = geometry {
        reanchorVerticalChars(&result, image: subject, geometry: g)
    }
    return result
}

/// Attach erased-band ruby as reading hints to the line directly below each
/// band.
func attachHints(
    _ result: inout [Line], hints hintBands: [(rect: CGRect, text: String)],
    subject: CGImage, geometry: Geometry?
) {
    // Attach erased-band ruby as reading hints to the line directly below
    // each band.
    if !hintBands.isEmpty, let g = geometry {
        let r = g.region
        let H = Double(subject.height)
        for hb in hintBands {
            let bandBottom =
                Double(hb.rect.maxY) / H * r.height
                + r.minY - g.window.minY
            let bandH = Double(hb.rect.height) / H * r.height
            var best = -1
            var bestD = Double.infinity
            for (i, line) in result.enumerated() {
                guard let top = line.chars.map(\.y).min() else { continue }
                // The base line's quads may overlap the erased band (engines
                // box generously); allow up to one band height of overlap.
                let d = top - bandBottom
                if d > -bandH, d < bestD {
                    bestD = d
                    best = i
                }
            }
            if best >= 0, bestD < bandH * 2.5 {
                result[best].hint = (result[best].hint ?? "") + hb.text
            }
        }
    }
}
