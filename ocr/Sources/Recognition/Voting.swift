// Majority vote across re-reads of a static page.

import CoreGraphics
import Foundation

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
    struct BKey: Hashable {
        let x: Int
        let y: Int
    }
    let cell = 32.0
    var grids: [[BKey: [CharBox]]] = []
    for pass in passes {
        var g: [BKey: [CharBox]] = [:]
        for l in pass {
            for c in l.chars {
                let k = BKey(
                    x: Int((c.x + c.w / 2) / cell),
                    y: Int((c.y + c.h / 2) / cell))
                g[k, default: []].append(c)
            }
        }
        grids.append(g)
    }
    func nearest(
        _ g: [BKey: [CharBox]], _ cx: Double, _ cy: Double,
        _ tol: Double
    ) -> CharBox? {
        let bx = Int(cx / cell)
        let by = Int(cy / cell)
        var best: CharBox? = nil
        var bestD = tol
        for dx in -1...1 {
            for dy in -1...1 {
                for c in g[BKey(x: bx + dx, y: by + dy)] ?? [] {
                    let d = max(abs(c.x + c.w / 2 - cx), abs(c.y + c.h / 2 - cy))
                    if d < bestD {
                        bestD = d
                        best = c
                    }
                }
            }
        }
        return best
    }
    let n = Double(passes.count)
    return base.map { line in
        var out = line
        out.chars = line.chars.map { c in
            let cx = c.x + c.w / 2
            let cy = c.y + c.h / 2
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
