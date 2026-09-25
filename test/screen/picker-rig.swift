// A process shaped like a game run through CrossOver, for the screen suite:
// a bare Mach-O with no Info.plist, so LaunchServices knows it only by its
// binary's name and has no bundle id for it (issue #20). test/run.sh compiles
// it under a name longer than the 31 bytes the window server keeps.
//
//   <binary> X Y    one 900x650 window whose top-left is at X,Y, in the
//                   top-left-origin screen coordinates CGWindowList reports
//
// Prints "<bundle id>\t<name>" as LaunchServices sees this process, so the
// suite compares the picker with the process's own view, not a constant.

import AppKit

let arguments = CommandLine.arguments
let left = Double(arguments.count > 1 ? arguments[1] : "") ?? 200
let top = Double(arguments.count > 2 ? arguments[2] : "") ?? 200
let size = NSSize(width: 900, height: 650)

let app = NSApplication.shared
// Accessory, so it has no Dock tile and never becomes frontmost. The picker
// lists it all the same: NSWorkspace.runningApplications holds both kinds.
app.setActivationPolicy(.accessory)
// AppKit's origin is the main display's bottom-left corner, y growing up.
let mainHeight = NSScreen.screens.first?.frame.height ?? 0
let window = NSWindow(
    contentRect: NSRect(
        x: left, y: mainHeight - top - size.height,
        width: size.width, height: size.height),
    styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "rig window"
window.orderFrontRegardless()

let me = NSRunningApplication.current
print("\(me.bundleIdentifier ?? "")\t\(me.localizedName ?? "")")
fflush(stdout)
app.run()
