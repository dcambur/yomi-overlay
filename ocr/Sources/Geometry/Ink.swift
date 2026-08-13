// Pixel-level primitives: ink masks, run detection, and the image
// transforms built on them. Shared by Tategaki and Furigana.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

/// Writes a captured frame to disk. Diagnostic only: what ScreenCaptureKit
/// actually hands back — image size and where the window sits inside it — is
/// the one thing the coordinate math depends on and cannot be inferred.
func dumpImage(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)
    else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

/// Rotate 90° counter-clockwise, so tategaki becomes ordinary horizontal text.
///
/// CCW specifically: a column reads top-to-bottom and columns run right-to-left,
/// so rotating CCW puts the first character of the rightmost column at the top
/// LEFT. Vision then returns lines in true reading order — the rightmost column
/// first — and characters within each line already left-to-right. Rotating the
/// other way would reverse both.
func rotated90CCW(_ image: CGImage) -> CGImage? {
    let w = image.width, h = image.height
    guard let space = image.colorSpace,
          let ctx = CGContext(data: nil, width: h, height: w,
                              bitsPerComponent: image.bitsPerComponent,
                              bytesPerRow: 0, space: space,
                              bitmapInfo: image.bitmapInfo.rawValue)
    else { return nil }
    // CGContext is bottom-left; rotating by +90° and shifting puts the source
    // rect back inside the (h x w) canvas.
    ctx.translateBy(x: CGFloat(h), y: 0)
    ctx.rotate(by: .pi / 2)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

/// Ink mask of an image, downsampled by `step`, as a [width][height] grid.
func inkMask(_ image: CGImage, step: Int) -> (w: Int, h: Int, ink: [Bool])? {
    guard let data = image.dataProvider?.data as Data? else { return nil }
    let bpr = image.bytesPerRow
    let bpp = max(1, image.bitsPerPixel / 8)
    guard bpp >= 3 else { return nil }
    let w = image.width / step, h = image.height / step
    guard w > 4, h > 4 else { return nil }
    var ink = [Bool](repeating: false, count: w * h)
    for gy in 0..<h {
        let row = (gy * step) * bpr
        for gx in 0..<w {
            let i = row + (gx * step) * bpp
            guard i + 3 < data.count else { continue }
            let b0 = data[i], b1 = data[i + 1], b2 = data[i + 2], b3 = data[i + 3]
            // Transparent pixels are all-zero when premultiplied, which reads
            // as pure black to a naive luminance test — and the area of the
            // capture not covered by the window is entirely transparent, so
            // without this the whole page is "ink" and every column merges.
            if b0 == 0 && b1 == 0 && b2 == 0 && b3 == 0 { continue }
            // Darkest channel, so the test works whatever the channel order.
            let darkest = min(min(b0, b1), min(b2, b3))
            ink[gy * w + gx] = darkest < 110
        }
    }
    return (w, h, ink)
}

/// Runs of consecutive indices whose count exceeds `minInk`, separated by gaps
/// of at least `minGap`.
func runs(_ counts: [Int], minInk: Int, minGap: Int) -> [(Int, Int)] {
    var out: [(Int, Int)] = []
    var start: Int? = nil
    var gap = 0
    for (i, c) in counts.enumerated() {
        if c > minInk {
            if start == nil { start = i }
            gap = 0
        } else if let s = start {
            gap += 1
            if gap >= minGap { out.append((s, i - gap)); start = nil; gap = 0 }
        }
    }
    if let s = start { out.append((s, counts.count - 1)) }
    return out
}

/// Plain 2x bilinear upscale via CGContext.
func upscale2x(_ image: CGImage) -> CGImage? {
    let w = image.width * 2, h = image.height * 2
    guard let space = image.colorSpace,
          let ctx = CGContext(data: nil, width: w, height: h,
                              bitsPerComponent: image.bitsPerComponent,
                              bytesPerRow: 0, space: space,
                              bitmapInfo: image.bitmapInfo.rawValue)
    else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}
