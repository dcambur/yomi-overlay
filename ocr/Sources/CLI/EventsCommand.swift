// --events: the global modifier/click monitor. Nothing here touches
// capture or recognition; it exists because the overlay panel cannot
// see these events itself.

import AppKit
import CoreGraphics
import Foundation

/// Streams global Shift presses and clicks as NDJSON.
///
/// The overlay cannot see these itself: it is focusable:false (so the target keeps
/// keyboard focus) and click-through (so page turns still work), which means
/// only mouse-move messages ever reach it. A global monitor is the only way to
/// trigger a lookup without requiring the cursor to move.
///
/// Needs Accessibility permission. Without it the monitors silently never fire,
/// and the overlay falls back to shift+move.
func streamEvents(modifier: String) {
    let flag: NSEvent.ModifierFlags
    switch modifier {
    case "control", "ctrl": flag = .control
    case "option", "alt": flag = .option
    case "command", "cmd": flag = .command
    default: flag = .shift
    }
    var wasDown = false

    func emit(_ type: String) {
        // Cocoa screen coords are bottom-left origin; convert to the top-left
        // origin every other part of this pipeline uses.
        let p = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        let y = screenHeight - p.y
        print("{\"type\":\"\(type)\",\"x\":\(Int(p.x)),\"y\":\(Int(y))}")
        fflush(stdout)
    }

    NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { ev in
        let down = ev.modifierFlags.contains(flag)
        // Fire on the press edge only, not on release or repeats.
        if down && !wasDown { emit("modifier") }
        wasDown = down
    }

    NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { _ in
        emit("click")
    }

    // No Space-change notification here, though this is where one belongs:
    // NSWorkspace.activeSpaceDidChangeNotification never arrives in a process
    // with no windows of its own (measured — didActivateApplication arrives on
    // the same observer, through the same parking, several times a minute;
    // activeSpaceDidChange did not fire on a real swipe). The watch loop
    // notices instead, between captures — see stillVisible().

    FileHandle.standardError.write(
        "event monitor started (needs Accessibility permission)\n".data(using: .utf8)!)
}

/// --events: start the monitor, then park forever.
func runEventsCommand(_ opts: Options) async -> Never {
    streamEvents(modifier: opts.modifier)
    // Park the task forever. Sleeping keeps the main queue (and
    // therefore the run loop the monitors deliver on) draining,
    // without the run-loop calls that Swift 6 forbids in an async
    // context.
    while true {
        try? await Task.sleep(nanoseconds: 3_600_000_000_000)
    }
    exit(0)
}
