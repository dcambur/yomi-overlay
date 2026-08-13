// Ruby: finding it, erasing it before recognition, and marking what
// survives as a reading hint rather than text.
//
// Split from the original single-file OCR helper; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

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

/// Erase furigana from a page that is COMMITTED horizontal, and keep what was
/// erased as reading hints.
///
/// Split out of recognize(). Callers must not run this during an orientation
/// PROBE: a vertical page's row projection is full of band-like runs, so
/// stripping one mutilates its columns and cost 5x CER on the vertical suites
/// (measured). recognizeAuto re-reads once right after committing horizontal,
/// so ruby'd pages still get the strip on their first real read.
func stripFurigana(_ subject: CGImage)
        -> (image: CGImage, hints: [(rect: CGRect, text: String)]) {
    var out = subject
    var hints: [(rect: CGRect, text: String)] = []
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
            if !texts[i].isEmpty { hints.append((candidates[i], texts[i])) }
        }
    }
    if !erase.isEmpty, let clean = eraseBands(subject, erase) {
        FileHandle.standardError.write(
            "furigana: stripped \(erase.count) of \(candidates.count) bands\n"
                .data(using: .utf8)!)
        out = clean
    }

    return (out, hints)
}
