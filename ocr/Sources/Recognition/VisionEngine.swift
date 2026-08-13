// The Vision binding, normalized to the shared line/char shape.
//
// Split from the original single-file OCR helper; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

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
        throws -> [RecognizedLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.recognitionLevel = .accurate
    // Language correction rewrites Japanese badly (it assumes word-delimited
    // text); off gives cleaner raw output for dictionary lookup.
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: subject, options: [:])
    try handler.perform([request])
    guard let observations = request.results else { return [] }

    var out: [RecognizedLine] = []
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        let s = top.string
        var chars: [RecognizedChar] = []
        if wantChars {
            for idx in s.indices {
                let chStr = String(s[idx])
                if chStr.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                guard let q = try? top.boundingBox(for: idx..<s.index(after: idx))
                else { continue }
                // boundingBox(for:) returns a quad; use its axis-aligned bounds.
                var n = NBox(vision: q.boundingBox)
                if unrotate { n = n.unrotatedCCW }
                chars.append(RecognizedChar(
                    ch: chStr,
                    box: CGRect(x: n.x, y: n.y, width: n.w, height: n.h)))
            }
        }
        let lb = NBox(vision: obs.boundingBox)
        out.append(RecognizedLine(
            text: s,
            box: CGRect(x: lb.x, y: lb.y, width: lb.w, height: lb.h),
            chars: chars))
    }
    return out
}
