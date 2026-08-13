// stderr notes that earned their keep, and the state that keeps them
// from repeating every pass.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

/// Set from --dump; lets the recognition stage write the rotated subject too.
var debugDumpPath: String?

var lastLoggedEngine = ""
func logEngineOnce(_ name: String) {
    guard name != lastLoggedEngine else { return }
    lastLoggedEngine = name
    FileHandle.standardError.write("engine: \(name)\n".data(using: .utf8)!)
}
