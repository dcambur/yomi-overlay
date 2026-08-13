// The window-enumeration commands: --list-all, --list, --debug, --frame.
//
// Split from Main.main(); see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision


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
    let info = CGWindowListCopyWindowInfo(
        [.optionAll, .excludeDesktopElements],
        kCGNullWindowID) as? [[String: Any]] ?? []
    let onScreenIDs = Set((CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID) as? [[String: Any]] ?? [])
        .compactMap { $0[kCGWindowNumber as String] as? Int })

    // Map owning pid -> bundle id, which CGWindowList does not give.
    var bundleFor: [pid_t: String] = [:]
    for a in NSWorkspace.shared.runningApplications {
        if let b = a.bundleIdentifier { bundleFor[a.processIdentifier] = b }
    }

    var items: [String] = []
    for w in info {
        // Bounds bridge as NSNumber, not CGFloat — casting the
        // dictionary to [String: CGFloat] silently yields nil and
        // drops every window.
        guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
              let bounds = w[kCGWindowBounds as String] as? [String: Any],
              let width = (bounds["Width"] as? NSNumber)?.doubleValue,
              let height = (bounds["Height"] as? NSNumber)?.doubleValue,
              width >= 300, height >= 200 else { continue }
        let bid = bundleFor[pid] ?? ""
        if bid.isEmpty || bid.hasPrefix("com.apple.dock") { continue }
        let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
        let title = w[kCGWindowName as String] as? String ?? ""
        let wid = w[kCGWindowNumber as String] as? Int ?? 0
        let ox = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
        let oy = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
        items.append("""
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

/// --debug: dump what ScreenCaptureKit can see, unfiltered.
func runDebugCommand() async throws -> Never {
    let all = try await SCShareableContent.excludingDesktopWindows(
        false, onScreenWindowsOnly: true)
    print("total shareable windows: \(all.windows.count)")
    for w in all.windows {
        let app = w.owningApplication
        let bid = app?.bundleIdentifier ?? "<nil>"
        guard bid.lowercased().contains("amazon") || bid.lowercased().contains("kindle")
            || (w.title ?? "").lowercased().contains("kindle") || w.frame.width > 400
        else { continue }
        print("  bundle=\(bid)")
        print("    app=\(app?.applicationName ?? "?")  title=\(w.title ?? "<nil>")")
        print("    frame=\(Int(w.frame.width))x\(Int(w.frame.height)) "
            + "@\(Int(w.frame.origin.x)),\(Int(w.frame.origin.y)) "
            + "onScreen=\(w.isOnScreen) layer=\(w.windowLayer) id=\(w.windowID)")
    }
    exit(0)
}

/// --list: the target's matching windows.
func runListCommand(_ windows: [SCWindow]) -> Never {
    if windows.isEmpty {
        print("no Kindle windows found")
    } else {
        for w in windows {
            let title = w.title ?? "(untitled)"
            print("id=\(w.windowID)  \(Int(w.frame.width))x\(Int(w.frame.height))  \(title)")
        }
    }
    exit(windows.isEmpty ? 1 : 0)
}

/// --frame: stream the target window's bounds as NDJSON.
func runFrameCommand(_ opts: Options) async throws -> Never {
    // Emit the Kindle window bounds as NDJSON so the overlay can
    // track it with one long-lived process instead of respawning.
    repeat {
        if let w = (try? await chooseWindow()) ?? nil {
            let f = w.frame
            let title = (w.title ?? "").replacingOccurrences(of: "\"", with: "\\\"")
            print("""
                {"x":\(Int(f.origin.x)),"y":\(Int(f.origin.y)),\
                "width":\(Int(f.width)),"height":\(Int(f.height)),\
                "id":\(w.windowID),"title":"\(title)"}
                """)
            fflush(stdout)
        } else {
            print("{\"error\":\"no-window\"}")
            fflush(stdout)
        }
        if opts.watch {
            try await Task.sleep(nanoseconds: UInt64(opts.interval * 1_000_000_000))
        }
    } while opts.watch
    exit(0)
}
