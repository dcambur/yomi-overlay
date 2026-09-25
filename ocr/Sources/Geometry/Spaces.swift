// The coordinate spaces this pipeline moves boxes between.

import CoreGraphics
import Foundation

/// A box in normalised image coordinates with a TOP-LEFT origin.
///
/// Vision reports bottom-left normalised boxes; everything downstream of here
/// is top-left. Converting once, up front, keeps the sign errors out of every
/// consumer.
struct NBox {
    var x: Double, y: Double, w: Double, h: Double

    init(vision b: CGRect) {
        x = b.minX
        y = 1 - b.maxY
        w = b.width
        h = b.height
    }
    init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/// Where a recognised box lands on screen, and how to express it in the
/// overlay's coordinate system.
///
/// `region` is what the image covers; `window` is what the overlay is pinned
/// to. Vision reports normalised coordinates, so a box is first mapped into
/// `region`, then rebased onto `window`. When the two are the same rectangle —
/// the ordinary window-filter capture — this collapses to a plain scale.
struct Geometry {
    let region: CGRect
    let window: CGRect
}
