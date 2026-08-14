// Pixel-level primitives: ink masks, run detection, and the image
// transforms built on them. Shared by Tategaki and Furigana.

import Foundation
import CoreGraphics
import ImageIO

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

/// Ink cells no recognised line accounts for.
///
/// The mixed-content merge (`verticalRemainder`) exists because Vision reads
/// no vertical Japanese at all, so a page committed horizontal can hold whole
/// columns it never saw. It costs one full Live Text pass — measured 1.35 s
/// against the 0.85 s Vision read it supplements on a 37-line page, i.e. it
/// more than doubled every changed pass whether or not there was anything to
/// find, and on an ordinary novel page there never is.
///
/// This is the "or not" test, and it is a measurement rather than a guess
/// about the app: paint out every cell a recogniser already explained, and
/// whatever ink survives is something it could not read. Only then is the
/// second engine worth its second and a half.
/// Marks that stand out from the page, whatever the page's polarity.
///
/// NOT `inkMask`, which asks a different question — "where is the dark ink" —
/// for column and band segmentation, and is calibrated for dark-on-light.
/// Reusing it here mismarked an entire dark-mode block as ink: measured on a
/// white-on-black rendering of 狼と香辛料, 671 of 3,133 cells survived as
/// "unexplained" when every one of them was background, and the reader's dark
/// mode would have defeated the gate on every page.
///
/// The background is taken per tile rather than per page, because a page can
/// hold both polarities at once — a dark illustration on a light page is the
/// case that produced the measurement above.
func standoutMask(_ image: CGImage, step: Int) -> (w: Int, h: Int, mark: [Bool])? {
    guard let data = image.dataProvider?.data as Data? else { return nil }
    let bpr = image.bytesPerRow
    let bpp = max(1, image.bitsPerPixel / 8)
    guard bpp >= 3 else { return nil }
    let w = image.width / step, h = image.height / step
    guard w > 4, h > 4 else { return nil }

    // Luminance per cell; -1 for the fully transparent pixels outside the
    // window, which are neither background nor mark.
    var lum = [Int](repeating: -1, count: w * h)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let n = raw.count
        for gy in 0..<h {
            let row = (gy * step) * bpr
            for gx in 0..<w {
                let i = row + (gx * step) * bpp
                guard i + bpp - 1 < n else { continue }
                let r = Int(raw[i]), g = Int(raw[i + 1]), b = Int(raw[i + 2])
                if bpp >= 4, r == 0, g == 0, b == 0, Int(raw[i + 3]) == 0 { continue }
                lum[gy * w + gx] = (r * 299 + g * 587 + b * 114) / 1000
            }
        }
    }

    // Per-tile background = median luminance of that tile.
    let tile = 16
    var mark = [Bool](repeating: false, count: w * h)
    var bucket: [Int] = []
    bucket.reserveCapacity(tile * tile)
    for ty in stride(from: 0, to: h, by: tile) {
        for tx in stride(from: 0, to: w, by: tile) {
            bucket.removeAll(keepingCapacity: true)
            for gy in ty..<min(ty + tile, h) {
                for gx in tx..<min(tx + tile, w) where lum[gy * w + gx] >= 0 {
                    bucket.append(lum[gy * w + gx])
                }
            }
            guard bucket.count > 4 else { continue }
            bucket.sort()
            let bg = bucket[bucket.count / 2]
            for gy in ty..<min(ty + tile, h) {
                for gx in tx..<min(tx + tile, w) {
                    let l = lum[gy * w + gx]
                    if l >= 0, abs(l - bg) > 60 { mark[gy * w + gx] = true }
                }
            }
        }
    }
    return (w, h, mark)
}

func unexplainedInkCells(_ image: CGImage, explainedBy lines: [RecognizedLine],
                         step: Int = 8) -> Int? {
    guard let mask = standoutMask(image, step: step) else { return nil }
    var ink = mask.mark
    for l in lines {
        // One cell of slack around each box: engines box text tightly, the
        // mask is downsampled, and a line's edge cells straddle both.
        let x0 = max(0, Int(l.box.minX * Double(mask.w)) - 1)
        let x1 = min(mask.w - 1, Int(l.box.maxX * Double(mask.w)) + 1)
        let y0 = max(0, Int(l.box.minY * Double(mask.h)) - 1)
        let y1 = min(mask.h - 1, Int(l.box.maxY * Double(mask.h)) + 1)
        guard x0 <= x1, y0 <= y1 else { continue }
        for gy in y0...y1 {
            let row = gy * mask.w
            for gx in x0...x1 { ink[row + gx] = false }
        }
    }
    return ink.reduce(0) { $0 + ($1 ? 1 : 0) }
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
