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
               vertical: Bool = false,
               session: RecognitionSession) async throws -> [Line] {
    // Vision cannot read tategaki at all — measured on a real vertical page:
    // 189 characters present, 0 recognised, 0 lines.
    // Vertical pages are re-flowed, not rotated — see the tategaki section.
    var reflow: (image: CGImage, rows: [[Cell]], cell: Int, pad: Int)? = nil
    if vertical {
        let cols = tategakiCells(image)
        reflow = reflowStrip(image, columns: cols)
    }
    var subject = reflow?.image ?? image
    if vertical, let dp = session.debugDumpPath { dumpImage(subject, to: dp + ".rot.png") }

    // Furigana removal BEFORE recognition — ONLY once the page is COMMITTED
    // horizontal. Running it during the h-probe of a vertical page erases
    // pieces of columns (a vertical page's row projection is full of
    // band-like runs) and cost 5x CER on the vertical suites, measured.
    // recognizeAuto re-reads once right after the probe commits horizontal,
    // so ruby'd pages still get the strip on their first real read.
    var hintBands: [(rect: CGRect, text: String)] = []
    // Furigana removal BEFORE recognition, and ONLY once the page is
    // COMMITTED horizontal — see stripFurigana for why a probe pass must not
    // run it.
    if !vertical, reflow == nil, session.orientation == .horizontal {
        let stripped = stripFurigana(subject)
        subject = stripped.image
        hintBands = stripped.hints
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
    var raw: [RecognizedLine]? = nil
    if session.engineMode != .vision, LiveText.usable, reflow == nil,
       session.engineMode == .livetext || session.orientation != .horizontal {
        raw = await LiveText.analyze(subject)
    }
    // Which engine actually ran, once per switch. "auto" resolving to vision
    // silently would make a broken Live Text invisible; say so.
    session.logEngineOnce(raw != nil ? "livetext" : "vision")
    session.flatReadNativeVertical = false
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
            session.flatReadNativeVertical = true
        }
    }
    var lines: [RecognizedLine] = try raw
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
    if raw == nil, reflow == nil, !vertical, session.orientation == .horizontal,
       session.engineMode == .auto {
        let extra = await verticalRemainder(subject, horizontal: lines)
        if !extra.isEmpty {
            let note = "mixed: merged \(extra.count) vertical line(s) into a "
                + "horizontal page\n"
            if note != session.lastMixedNote {
                session.lastMixedNote = note
                FileHandle.standardError.write(note.data(using: .utf8)!)
            }
            lines.append(contentsOf: extra)
        }
    }


    // Re-flowed page: a recognised line corresponds to one source column.
    if let rf = reflow, let g = geometry {
        return mapReflowedStrip(lines, reflow: rf, image: image,
                                subject: subject, geometry: g)
    }

    var result = mapFlatLines(lines, subject: subject, geometry: geometry,
                              vertical: vertical, mergedFrom: mergedFrom,
                              fromLiveText: raw != nil, session: session)
    attachHints(&result, hints: hintBands, subject: subject, geometry: geometry)
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
