// The stdin crop channel serving regions of the last captured frame.

import CoreGraphics
import Foundation

// MARK: - Crop command channel (INTEGRATION.md Phase 3)
//
// The overlay's Tier-2 path needs pixels for the region under the cursor.
// Re-capturing would need a second SCK session — concurrent sessions stall
// (measured; see CONVENTIONS) — so the watch process serves crops of its own
// LAST captured frame. Protocol: one line on stdin,
//     crop <id> <x> <y> <w> <h> <path>
// with x/y/w/h in frame-relative points (the same space as emitted char
// boxes). The crop is upscaled 2x (the accurate tier reads small regions
// better big) and written to <path>; the reply
//     {"crop":{"id":N,"path":"...","ok":true}}
// is emitted from the MAIN loop, never the reader thread — a stdout write
// from another thread can interleave with a multi-KB payload line and
// corrupt the NDJSON stream.
final class CropChannel {
    struct Req {
        let id: Int
        let rect: CGRect
        let path: String
    }
    private let lock = NSLock()
    private var pending: [Req] = []
    private var lastImage: CGImage?
    private var lastRegion: CGRect = .zero

    func startReader() {
        let t = Thread {
            while let line = readLine(strippingNewline: true) {
                let p = line.split(separator: " ")
                guard p.count == 7, p[0] == "crop",
                    let id = Int(p[1]), let x = Double(p[2]), let y = Double(p[3]),
                    let w = Double(p[4]), let h = Double(p[5])
                else { continue }
                self.lock.lock()
                self.pending.append(
                    Req(
                        id: id,
                        rect: CGRect(x: x, y: y, width: w, height: h),
                        path: String(p[6])))
                self.lock.unlock()
            }
        }
        t.name = "crop-stdin"
        t.start()
    }

    func store(_ image: CGImage, region: CGRect) {
        lock.lock()
        lastImage = image
        lastRegion = region
        lock.unlock()
    }

    /// Serve queued requests. Called once per watch pass on the main loop.
    func drain() {
        lock.lock()
        let reqs = pending
        pending = []
        let img = lastImage
        let region = lastRegion
        lock.unlock()
        guard !reqs.isEmpty else { return }
        for r in reqs {
            var ok = false
            if let img, region.width > 0 {
                // Frame points -> capture pixels (Retina: image is 2x region).
                let sx = Double(img.width) / region.width
                let sy = Double(img.height) / region.height
                let px = CGRect(
                    x: r.rect.minX * sx, y: r.rect.minY * sy,
                    width: r.rect.width * sx, height: r.rect.height * sy
                )
                .intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
                if !px.isEmpty, let crop = img.cropping(to: px),
                    let up = upscale2x(crop)
                {
                    dumpImage(up, to: r.path)
                    ok = true
                }
            }
            print("{\"crop\":{\"id\":\(r.id),\"path\":\"\(jsonEscape(r.path))\",\"ok\":\(ok)}}")
            fflush(stdout)
        }
    }
}
let cropChannel = CropChannel()
