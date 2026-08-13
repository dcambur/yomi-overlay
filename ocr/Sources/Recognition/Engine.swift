// The shape both recognizers speak.
//
// Vision and Live Text are called differently and are chosen per page by a
// measured policy (see Recognizer.swift), but everything downstream of the
// read — the strip mapping, the flat mapping, the mixed-content merge — works
// on this and never learns which engine ran.
//
// That shape used to live inside `LiveText`, so the Vision path returned
// `[LiveText.RLine]`: the Vision function's return type was named after the
// other engine. Nothing was wrong with the code; the name was just admitting
// that the shared currency had no home of its own.
//
// Deliberately NOT a `RecognitionEngine` protocol. The two engines do not have
// a common call shape and forcing one would be ceremony:
//
//   - LiveText.analyze is async and returns nil to mean "failed this pass,
//     fall back"; visionLines throws and takes `unrotate` and `wantChars`,
//     which have no Live Text analogue.
//   - verticalRemainder calls Live Text *by name* on purpose — Vision reads no
//     vertical Japanese at all, so there is no engine-agnostic version of it.
//   - The choice between them is a per-engine policy paid for in measurements
//     (CER 0.3% vs 0.6% horizontal; 89% vs 66% placement on the reflow strip).
//     A protocol would sit above that if/else without removing it.
//
// One shared vocabulary, two named engines, an explicit policy.

import CoreGraphics

/// One recognised character and where it sits, in normalised subject
/// coordinates with a TOP-LEFT origin.
///
/// Always one entry per character, even when an engine reports multi-character
/// tokens — the Live Text path subdivides those before they get here, because
/// the overlay places one span per glyph.
struct RecognizedChar {
    let ch: String
    let box: CGRect
}

/// One recognised line: its text, its own box, and its characters.
struct RecognizedLine {
    let text: String
    let box: CGRect
    let chars: [RecognizedChar]
}
