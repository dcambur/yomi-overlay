// An invisible display for the screen suite (test/screen/screen.js).
//
// To the window server it is a real display: windows on it are composited,
// ScreenCaptureKit captures them, CGWindowList lists them on screen, and a
// window made fullscreen there gets a Space of its own. No monitor shows it,
// so nothing the suite opens ever appears on the user's screen.
//
// Prints one line once the display is up and placed —
//   {"id":5,"x":1440,"y":900,"width":1440,"height":900}
// — and holds it until stdin closes. The display belongs to this process and
// goes when the process does: measured, even a SIGKILL removes it at once, so
// a suite that crashes cannot leave a screen behind.
//
// Built on demand by test/run.sh into bin/test/; never part of the app.

import CoreGraphics
import Foundation

// 1440x900 points, the geometry of the laptop panel the app is used on most.
// At 1x: macOS lists a 1440x900 2x mode for a virtual display but will not
// switch to it (measured: not usable for the desktop, and
// CGConfigureDisplayWithDisplayMode fails with kCGErrorFailure), and the 2x
// modes it does allow are 960x600 or 2880x1800 points — the second a 20 MP
// capture on every pass.
let pointsWide: UInt32 = 1440
let pointsHigh: UInt32 = 900

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("virtual-display: \(message)\n".utf8))
    exit(1)
}

/// Poll until `done` holds; the window server applies display changes
/// asynchronously. Services the main queue meanwhile, which the display's own
/// callbacks run on.
func waitUntil(_ what: String, _ done: () -> Bool) {
    let deadline = Date().addingTimeInterval(3)
    while !done() {
        if Date() > deadline { fail("timed out waiting for \(what)") }
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
}

func isActive(_ id: CGDirectDisplayID) -> Bool {
    var count: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    CGGetActiveDisplayList(32, &ids, &count)
    return ids.prefix(Int(count)).contains(id)
}

let descriptor = CGVirtualDisplayDescriptor()
descriptor.queue = DispatchQueue.main
descriptor.name = "yomi test display"
descriptor.maxPixelsWide = pointsWide
descriptor.maxPixelsHigh = pointsHigh
// A desktop monitor's density; with it macOS offers the mode below at 1x.
let millimetresPerPoint = 25.4 / 110
descriptor.sizeInMillimeters = CGSize(
    width: Double(pointsWide) * millimetresPerPoint,
    height: Double(pointsHigh) * millimetresPerPoint)
descriptor.productID = 0x7E57
descriptor.vendorID = 0x7E57
descriptor.serialNum = 1

guard let display = CGVirtualDisplay(descriptor: descriptor) else {
    fail("could not create a display")
}
let settings = CGVirtualDisplaySettings()
settings.modes = [CGVirtualDisplayMode(width: pointsWide, height: pointsHigh, refreshRate: 60)]
guard display.apply(settings) else { fail("the display refused its mode") }
let id = display.displayID
waitUntil("the display to come up") { isActive(id) }

// Corner contact only. Added the default way, the display shares an edge with
// the main one, and a cursor pushed past that edge vanishes onto a screen
// nobody can see. App-only: the arrangement reverts when this process ends.
let main = CGDisplayBounds(CGMainDisplayID())
let corner = CGPoint(x: main.maxX, y: main.maxY)
var config: CGDisplayConfigRef?
CGBeginDisplayConfiguration(&config)
CGConfigureDisplayOrigin(config, id, Int32(corner.x), Int32(corner.y))
if CGCompleteDisplayConfiguration(config, .forAppOnly) != .success {
    fail("could not place the display")
}
waitUntil("the display to move") { CGDisplayBounds(id).origin == corner }

let bounds = CGDisplayBounds(id)
let line =
    "{\"id\":\(id),\"x\":\(Int(bounds.minX)),\"y\":\(Int(bounds.minY)),"
    + "\"width\":\(Int(bounds.width)),\"height\":\(Int(bounds.height))}"
print(line)
fflush(stdout)

// Held until the parent is done with it. EOF arrives when the parent closes
// the pipe or dies, so no signal handling is needed for either.
DispatchQueue.global().async {
    _ = FileHandle.standardInput.readDataToEndOfFile()
    exit(0)
}
dispatchMain()
