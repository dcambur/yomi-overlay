// The window-enumeration commands: --list-all and --list.

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// --list-all: every capturable window as JSON, for the settings picker.
func runListAllCommand() -> Never {
    // CGWindowListCopyWindowInfo rather than SCShareableContent:
    // it returns in ~50ms and, crucially, still works without
    // Screen Recording permission (titles come back empty, but the
    // owning app and geometry are enough to pick a target). SCK
    // stalls for seconds before failing when permission is absent,
    // which made the settings picker look hung.
    // Not .optionOnScreenOnly: a target sitting on another Space
    // must still be pickable.
    let info =
        CGWindowListCopyWindowInfo(
            [.optionAll, .excludeDesktopElements],
            kCGNullWindowID) as? [[String: Any]] ?? []
    let onScreenIDs = Set(
        (CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID) as? [[String: Any]] ?? [])
            .compactMap { $0[kCGWindowNumber as String] as? Int })

    // Map owning pid -> the application LaunchServices knows it as, which
    // CGWindowList does not give. A pid with no entry is not an application
    // (the window server, agents) and is skipped below. Having no BUNDLE ID
    // is a different thing: a bare executable is still an app with a Dock
    // tile, named after its binary — which is what every game run through
    // CrossOver is (Wine names the process after the .exe; there is no
    // Info.plist to carry an id). Measured 2026-09-10 on such a process:
    // bundleIdentifier nil, localizedName "Game.exe"; skipping on an empty
    // id hid all of its windows from the picker (issue #20).
    var appFor: [pid_t: NSRunningApplication] = [:]
    for a in NSWorkspace.shared.runningApplications { appFor[a.processIdentifier] = a }

    var items: [String] = []
    for w in info {
        // Bounds bridge as NSNumber, not CGFloat — casting the
        // dictionary to [String: CGFloat] silently yields nil and
        // drops every window.
        guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
            let bounds = w[kCGWindowBounds as String] as? [String: Any],
            let width = (bounds["Width"] as? NSNumber)?.doubleValue,
            let height = (bounds["Height"] as? NSNumber)?.doubleValue,
            width >= 300, height >= 200
        else { continue }
        guard let app = appFor[pid] else { continue }
        let bid = app.bundleIdentifier ?? ""
        if bid.hasPrefix("com.apple.dock") { continue }
        // The app's name comes from LaunchServices, not kCGWindowOwnerName:
        // the window server truncates the owner name to 31 bytes, which is
        // ten kanji. Measured 2026-09-14 on a CrossOver process named
        // 飼い犬勇者と魔王の城.exe: owner "飼い犬勇者と魔王の城." (31 bytes),
        // localizedName "飼い犬勇者と魔王の城.exe" (34). The picker showed
        // the first; --app matches SCK's applicationName, which is the
        // second; so the game was listed but could not be followed.
        let owner = app.localizedName ?? w[kCGWindowOwnerName as String] as? String ?? "?"
        let title = w[kCGWindowName as String] as? String ?? ""
        let wid = w[kCGWindowNumber as String] as? Int ?? 0
        let ox = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
        let oy = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
        items.append(
            """
            {"id":\(wid),"bundle":"\(jsonEscape(bid))",\
            "app":"\(jsonEscape(owner))","title":"\(jsonEscape(title))",\
            "x":\(Int(ox)),"y":\(Int(oy)),\
            "width":\(Int(width)),"height":\(Int(height)),\
            "onScreen":\(onScreenIDs.contains(wid))}
            """)
    }
    print("[\(items.joined(separator: ","))]")
    exit(0)
}

/// --list: the target's matching windows.
func runListCommand(_ windows: [SCWindow]) -> Never {
    if windows.isEmpty {
        print("no matching windows found")
    } else {
        for w in windows {
            let title = w.title ?? "(untitled)"
            print("id=\(w.windowID)  \(Int(w.frame.width))x\(Int(w.frame.height))  \(title)")
        }
    }
    exit(windows.isEmpty ? 1 : 0)
}
