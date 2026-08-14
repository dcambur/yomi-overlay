// The NDJSON contract with the overlay. stdout is data; stderr is
// diagnostics.

import Foundation
import CoreGraphics

/// True when a string can go into JSON exactly as it is.
///
/// Nearly every string here is one CJK glyph or one line of Japanese, and none
/// of those need escaping — so the common case should not allocate. It used to
/// build a fresh String scalar by scalar for every one of the ~2,200 glyphs on
/// a page, which is most of the payload-building cost the recogniser pays
/// after it has already done the reading (measured: 1.05s to recognise a
/// 1,050-glyph page and emit it, 0.83s to recognise it and not).
private func jsonClean(_ s: String) -> Bool {
    for u in s.unicodeScalars {
        if u == "\"" || u == "\\" || u.value < 0x20 { return false }
    }
    return true
}

func jsonEscape(_ s: String) -> String {
    if jsonClean(s) { return s }
    var out = ""
    out.reserveCapacity(s.unicodeScalars.count + 8)
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\t": out += "\\t"
        case "\r": out += "\\r"
        default:
            if u.value < 0x20 {
                out += String(format: "\\u%04x", u.value)
            } else {
                out.unicodeScalars.append(u)
            }
        }
    }
    return out
}

/// The parts of `f` another window is currently drawn over, expressed in the
/// same frame-local points as the glyph boxes.
///
/// Shipped with every payload AND every heartbeat: a window can be covered or
/// uncovered without one pixel of the target changing, and the consumer must
/// stop hit-testing glyphs the user cannot see the moment that happens.
func coversJSON(frame f: CGRect) -> String {
    let items = lastOccluders.compactMap { r -> String? in
        let hit = r.intersection(f)
        guard !hit.isNull, hit.width > 1, hit.height > 1 else { return nil }
        let pos = "\"x\":\(Int((hit.minX - f.minX).rounded(.down))),"
            + "\"y\":\(Int((hit.minY - f.minY).rounded(.down)))"
        let size = "\"w\":\(Int(hit.width.rounded(.up))),\"h\":\(Int(hit.height.rounded(.up)))"
        return "{" + pos + "," + size + "}"
    }
    return "[\(items.joined(separator: ","))]"
}

/// "The target has no window I can see." Not silence: the consumer needs to
/// tell this apart from a wedged watcher, and it is what tells the overlay to
/// get off the screen.
func emitIdle(json: Bool) {
    guard json else { return }
    print("{\"idle\":true}")
    fflush(stdout)
}

/// The every-pass "still here, nothing new" line. Carries the frame origin and
/// the cover regions, because both move while the recognised text does not.
func heartbeatJSON(frame f: CGRect) -> String {
    let frameJson = "{\"x\":\(Int(f.origin.x)),\"y\":\(Int(f.origin.y)),"
        + "\"width\":\(Int(f.width)),\"height\":\(Int(f.height))}"
    return "{\"frame\":\(frameJson),\"covers\":\(coversJSON(frame: f)),\"unchanged\":true}"
}

/// The watch payload. `vote` counts the passes behind this text (1 = single
/// read); the renderer uses it to update voted corrections in place. `f` per
/// char is the voting confidence, present only after a vote.
func buildPayload(_ lines: [Line], frame f: CGRect, window w: CGRect,
                  vertical: Bool, vote: Int, engine: String) -> String {
    // Long interpolations split into locals: the type-checker has timed out
    // on big concatenations twice before.
    let frameJson = "{\"x\":\(Int(f.origin.x)),\"y\":\(Int(f.origin.y)),"
        + "\"width\":\(Int(f.width)),\"height\":\(Int(f.height))}"
    let windowJson = "{\"x\":\(Int(w.origin.x)),\"y\":\(Int(w.origin.y)),"
        + "\"width\":\(Int(w.width)),\"height\":\(Int(w.height))}"
    let head = "{\"frame\":\(frameJson),\"covers\":\(coversJSON(frame: f)),"
        + "\"window\":\(windowJson),"
    let meta = "\"vertical\":\(vertical),\"engine\":\"\(engine)\",\"vote\":\(vote),"

    // One string, grown once, instead of a String per character joined into a
    // String per line joined into the payload. A full page is ~2,200 glyphs
    // and ~90 KB, and the old shape allocated several times that in
    // intermediates on a path the reader waits behind.
    var out = head + meta + "\"lines\":["
    out.reserveCapacity(64 * lines.reduce(0) { $0 + $1.chars.count } + 256)
    var firstLine = true
    for l in lines where !l.chars.isEmpty {
        if firstLine { firstLine = false } else { out += "," }
        out += "{\"text\":\"\(jsonEscape(l.text))\""
        if l.ruby { out += ",\"ruby\":true" }
        if l.vertical { out += ",\"vertical\":true" }
        if let hint = l.hint { out += ",\"hint\":\"\(jsonEscape(hint))\"" }
        out += ",\"chars\":["
        var firstChar = true
        for c in l.chars {
            if firstChar { firstChar = false } else { out += "," }
            out += "{\"c\":\"\(jsonEscape(c.ch))\",\"x\":\(Int(c.x)),\"y\":\(Int(c.y)),"
            out += "\"w\":\(Int(c.w.rounded(.up))),\"h\":\(Int(c.h.rounded(.up)))"
            if let conf = c.conf { out += ",\"f\":\(twoDecimals(conf))" }
            out += "}"
        }
        out += "]}"
    }
    return out + "]}"
}

/// `String(format: "%.2f", x)` for x in [0, 1], without NSString formatting —
/// which is per-character cost on a voted payload.
func twoDecimals(_ x: Double) -> String {
    let n = max(0, min(100, Int((x * 100).rounded())))
    return "\(n / 100).\(n % 100 < 10 ? "0" : "")\(n % 100)"
}

func emit(_ text: String, to path: String?) {
    guard let path else {
        print(text)
        return
    }
    // replaceItemAt requires the destination to already exist, so a first write
    // to a fresh path would silently do nothing and strand the .tmp file.
    // Foundation's atomic write covers that case on its own.
    guard FileManager.default.fileExists(atPath: path) else {
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
        return
    }
    let tmp = path + ".tmp"
    guard (try? text.write(toFile: tmp, atomically: true, encoding: .utf8)) != nil else {
        return
    }
    // Atomic replace so the web page never reads a half-written file.
    if (try? FileManager.default.replaceItemAt(
        URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))) == nil {
        try? FileManager.default.removeItem(atPath: tmp)
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    }
}
