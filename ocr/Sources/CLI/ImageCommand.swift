// --image: recognize a PNG from disk instead of capturing.

import CoreGraphics
import Foundation
import ImageIO

/// Recognizes a file. Needs no permission and no ScreenCaptureKit session,
/// so it runs while the overlay is up — a one-shot capture would stall on
/// the concurrent SCK session. This is what the CER harness and the
/// golden-master suite drive.
func runImageCommand(_ opts: Options, path imgPath: String) async -> Never {
    // File mode: recognize a PNG from disk. Needs no permission and
    // no ScreenCaptureKit session, so it runs while the overlay is
    // up (a one-shot *capture* would stall on the concurrent SCK
    // session — this path deliberately never opens one).
    guard
        let src = CGImageSourceCreateWithURL(
            URL(fileURLWithPath: imgPath) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else {
        FileHandle.standardError.write(
            "cannot read image: \(imgPath)\n".data(using: .utf8)!)
        exit(1)
    }
    // Region == window == image bounds: normalised boxes scale
    // straight to pixel coordinates, origin top-left. There is no
    // screen involved, so pixels are the coordinate system.
    let bounds = CGRect(
        x: 0, y: 0,
        width: image.width, height: image.height)
    if opts.cellsDump {
        let cols = tategakiCells(image)
        let colJson = cols.map { col in
            "["
                + col.map { c in
                    "{\"x\":\(Int(c.rect.minX)),\"y\":\(Int(c.rect.minY)),"
                        + "\"w\":\(Int(c.rect.width)),\"h\":\(Int(c.rect.height))}"
                }.joined(separator: ",") + "]"
        }.joined(separator: ",")
        print("{\"columns\":[\(colJson)]}")
        exit(0)
    }
    let geom = Geometry(region: bounds, window: bounds)
    let session = RecognitionSession(opts)
    do {
        var (lines, isVertical) = try await recognizeAuto(
            image, geometry: geom, forced: opts.vertical, session: session)
        markRuby(&lines, vertical: isVertical)
        if opts.json {
            emit(
                buildPayload(
                    lines, frame: bounds, window: bounds, covers: [],
                    vertical: isVertical, vote: 1,
                    engine: session.lastLoggedEngine))
        } else {
            emit(plainText(lines, session: session))
        }
    } catch {
        FileHandle.standardError.write(
            "recognition failed: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    exit(0)
}
