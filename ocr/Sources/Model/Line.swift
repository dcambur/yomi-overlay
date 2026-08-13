// What a recognised page is made of.

import Foundation
import CoreGraphics

struct Line {
    var text: String
    var box: CGRect  // normalized, origin bottom-left
    var chars: [CharBox] = []
    // Furigana (ruby) line: excluded from lookups and text output, kept in
    // the payload as a reading hint for its base line (Phase 4).
    var ruby = false
    // This line reads top-to-bottom. Per-LINE, not per-page: a native Live
    // Text read of a vertical page returns the page's horizontal furniture
    // (site headers, titles) in the same pass as the columns, and the popup
    // must place against the orientation of the line actually hit, not the
    // page majority. The payload-level `vertical` stays as the page-majority
    // fallback.
    var vertical = false
    // Concatenated ruby text of the furigana lines attached to this line.
    var hint: String? = nil
}

/// One character with its on-screen rectangle, in window points with the
/// origin at the window's top-left — directly usable as CSS left/top/width/height.
struct CharBox {
    var ch: String
    var x: Double, y: Double, w: Double, h: Double
    // Cross-pass agreement fraction from temporal voting (nil = single pass).
    // No engine here supplies real per-character confidence — Live Text
    // exposes none at all — so agreement across re-reads of a static page is
    // the confidence signal every downstream lever gates on.
    var conf: Double? = nil
}
