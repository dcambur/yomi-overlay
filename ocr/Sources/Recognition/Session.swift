// What one run has learned so far.
//
// These were six file-scope `var`s. None of them is a global fact — each is
// state a single run accumulates: which way this page reads, whether the last
// flat read looked native-vertical, which diagnostics have already been
// printed. Keeping them global meant nothing could set up a starting state,
// which is the entire reason --assume-horizontal exists as a production CLI
// flag rather than a line of test setup.
//
// A class, not a struct: recognizeAuto commits the orientation it discovers
// and recognize() reports back what shape the flat read came out as, and both
// have to be visible to the caller afterwards.

import Foundation

final class RecognitionSession {
    /// Which way the page's text runs. Sticky across passes: probing both
    /// orientations costs a second Vision pass, which is the expensive step.
    var orientation: Orientation

    /// Which recognizer reads the pixels. Fixed for the run.
    let engineMode: EngineMode

    /// From --dump; lets the recognition stage write the rotated subject too.
    let debugDumpPath: String?

    /// Set by recognize() when a flat Live Text read came back as native
    /// vertical columns; recognizeAuto turns it into orientation + the
    /// payload flag.
    var flatReadNativeVertical = false

    /// Mixed-content merge note, one stderr line per distinct message — every
    /// committed-horizontal pass on a manga page would otherwise repeat it.
    var lastMixedNote = ""

    /// Which engine last announced itself. Also the payload's `engine` field,
    /// which is why it is readable but not writable from outside.
    private(set) var lastLoggedEngine = ""

    init(orientation: Orientation = .unknown,
         engineMode: EngineMode = .auto,
         debugDumpPath: String? = nil) {
        self.orientation = orientation
        self.engineMode = engineMode
        self.debugDumpPath = debugDumpPath
    }

    /// The session a command runs with.
    convenience init(_ opts: Options) {
        self.init(orientation: opts.assumeHorizontal ? .horizontal : .unknown,
                  engineMode: opts.engine,
                  debugDumpPath: opts.dumpPath)
    }

    /// Which engine actually ran, once per switch. "auto" resolving to vision
    /// silently would make a broken Live Text invisible; say so.
    func logEngineOnce(_ name: String) {
        guard name != lastLoggedEngine else { return }
        lastLoggedEngine = name
        FileHandle.standardError.write("engine: \(name)\n".data(using: .utf8)!)
    }
}
