// Argument parsing to command dispatch, and nothing else. Every subcommand
// lives in CLI/.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ScreenCaptureKit

@main
struct Main {
    static func main() async {
        let opts = parseArgs()

        if opts.assumeHorizontal { orientation = .horizontal }

        // Establish a window-server connection. Without this a plain CLI
        // process has no CGS connection and the capture path aborts with
        // "Assertion failed: (did_initialize) ... CGS_REQUIRE_INIT".
        // .accessory keeps it off the Dock and out of the app switcher.
        let nsApp = NSApplication.shared
        nsApp.setActivationPolicy(.accessory)

        // These four need no ScreenCaptureKit call, and must run before one:
        // without Screen Recording permission SCShareableContent stalls for
        // seconds before failing, which made the settings picker look hung.
        if opts.checkPerm { runPermissionCheck() }
        if let imgPath = opts.imagePath { await runImageCommand(opts, path: imgPath) }
        if opts.events { await runEventsCommand(opts) }
        if opts.listAll { runListAllCommand() }

        do {
            let windows = try await targetWindows()

            if opts.debug { try await runDebugCommand() }
            if opts.list { runListCommand(windows) }

            // Watch mode must not die here: launched before the target app
            // (or while it is still opening), exiting put the supervisor into
            // its restart backoff — measured up to 30s of dead overlay per
            // retry, in a loop, until the app happened to be up during a
            // spawn (/tmp/yomi-overlay.log 2026-08-10 08:50→08:57). The watch
            // loop re-resolves the window every pass anyway; let it wait.
            guard !windows.isEmpty || opts.watch else {
                FileHandle.standardError.write(
                    "No matching window found. Use --list-all to see candidates.\n"
                        .data(using: .utf8)!)
                exit(1)
            }
            if windows.isEmpty {
                FileHandle.standardError.write(
                    "target has no window yet — watching until one appears\n"
                        .data(using: .utf8)!)
            }

            if opts.frame { try await runFrameCommand(opts) }

            try await runWatchLoop(opts)
        } catch {
            FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
    }
}
