// Vertical text: column and cell detection, the reflow strip, and
// re-anchoring native-vertical reads onto measured cells.

import Foundation
import CoreGraphics

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
