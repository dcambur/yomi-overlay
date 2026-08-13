// Every flag the tool accepts, and how it is parsed.
//
// Split from the single-file KindleOCR.swift; see docs/REFACTOR.md.

import AppKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import Vision

struct Options {
    var vertical = false
    var watch = false
    var interval: Double = 1.5
    var outPath: String?
    var list = false
    var frame = false
    var debug = false
    var json = false
    var listAll = false
    var events = false
    var checkPerm = false
    var dumpPath: String?
    // Recognize a PNG from disk instead of capturing. Exists for the CER
    // harness (test/cer.py) and engine head-to-heads: same recognizer, same
    // output shape, but reproducible input — no window, no permission, no SCK.
    var imagePath: String?
    // Temporal voting: re-OCR a static page up to `votes` times (every
    // `voteEvery`th unchanged pass) and majority-vote per character. 0 or 1
    // disables. JSON watch mode only.
    var votes = 3
    var voteEvery = 2
    // With --image: dump detected tategaki cells as JSON instead of OCR.
    // Instrumentation for the Phase 5 splitter benchmark — measures the
    // geometry mechanism with no recognizer in the loop.
    var cellsDump = false
    // Debug: pre-commit orientation to horizontal. A one-shot --image run
    // always starts at .unknown (probe path, Live Text), so the
    // committed-horizontal code paths — Vision, furigana strip, the mixed
    // vertical-remainder merge — are otherwise untestable headlessly.
    var assumeHorizontal = false
    // Which modifier arms a lookup. Shift is the Yomitan/10ten default but
    // collides with shift-click and some IME candidate selection, so it is
    // configurable; the overlay passes whatever the user chose.
    var modifier = "shift"
}

func parseArgs() -> Options {
    var o = Options()
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--vertical", "-v": o.vertical = true
        case "--assume-horizontal": o.assumeHorizontal = true
        case "--watch", "-w": o.watch = true
        case "--list", "-l": o.list = true
        case "--frame", "-f": o.frame = true
        case "--debug": o.debug = true
        case "--json", "-j": o.json = true
        case "--list-all": o.listAll = true
        case "--events": o.events = true
        case "--check-permission": o.checkPerm = true
        case "--dump":
            o.dumpPath = it.next()
            debugDumpPath = o.dumpPath
        case "--image":
            o.imagePath = it.next()
        case "--engine":
            if let e = it.next(), let m = EngineMode(rawValue: e.lowercased()) {
                engineMode = m
            } else {
                FileHandle.standardError.write(
                    "usage: --engine auto|vision|livetext\n".data(using: .utf8)!)
                exit(2)
            }
        case "--modifier":
            if let m = it.next() { o.modifier = m.lowercased() }
        case "--bundle":
            if let b = it.next() {
                if target.bundleIDs == defaultBundleIDs { target.bundleIDs = [] }
                target.bundleIDs.insert(b)
            }
        case "--window":
            if let w = it.next(), let id = UInt32(w) { target.windowID = CGWindowID(id) }
        case "--interval":
            if let s = it.next(), let d = Double(s) { o.interval = d }
        case "--votes":
            if let s = it.next(), let n = Int(s) { o.votes = n }
        case "--vote-every":
            if let s = it.next(), let n = Int(s) { o.voteEvery = max(1, n) }
        case "--cells":
            o.cellsDump = true
        case "--out", "-o": o.outPath = it.next()
        case "--help", "-h":
            print("""
            kindleocr — OCR the Kindle window only

              --list          list matching windows and exit
              --list-all      list every capturable window as JSON and exit
              --events        stream global modifier/click events as NDJSON
              --modifier NAME shift|control|option|command (default shift)
              --dump PATH     write the captured frame to a PNG (diagnostics)
              --image PATH    recognize a PNG from disk instead of capturing
              --assume-horizontal  debug: pre-commit horizontal orientation
                              (exercises the committed-horizontal paths headlessly)
              --engine NAME   auto|vision|livetext (default auto)
              --votes N       re-OCR a static page up to N times and majority-
                              vote per character (default 3; 0/1 disables)
              --vote-every N  vote on every Nth unchanged pass (default 2)
              --check-permission  report Screen Recording status as JSON
              --bundle ID     target an app by bundle id (repeatable)
              --window ID     target one specific window id
              --frame, -f     print Kindle window bounds as JSON and exit
              --vertical, -v  vertical (tategaki) reading order
              --watch, -w     re-capture continuously
              --interval N    seconds between captures in watch mode (default 1.5)
              --json, -j      emit NDJSON with per-character boxes
              --out PATH, -o  write text to PATH (default: stdout)
            """)
            exit(0)
        default:
            FileHandle.standardError.write("unknown argument: \(a)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    return o
}
