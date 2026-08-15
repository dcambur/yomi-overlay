// The private VisionKit binding.

import AppKit
import CoreGraphics
import Foundation

// MARK: - Live Text (private VisionKit path)
//
// The Tier-1 recognizer swap from INTEGRATION.md Phase 1. Vision cannot read
// tategaki at all (measured above); Apple's Live Text can, but only through
// the PRIVATE VisionKitCore classes — the public ImageAnalysis API exposes a
// bare `transcript`, no geometry. This binding follows the two working
// open-source precedents byte for byte: ocrmac's PyObjC calls (class names,
// requestType=1, the completion-block shape, the run-loop wait) and WebKit's
// SPI header (allLines/string/quad/children object graph). Cited third-party
// measurement to re-validate here: 618 chars read on a real vertical Kindle
// page where Vision read 6.
//
// Defensive posture, because the API is private and has broken between OS
// releases (class prefixes and a callback selector both changed historically):
// classes are looked up at runtime, every analysis has a hard timeout, and
// three consecutive failures permanently degrade this process to Vision with
// one stderr line. Live Text emits NO confidence signal (ocrmac hardcodes
// 1.0) — never treat its output as high-confidence.
enum LiveText {

    // VKCImageAnalyzer lives in VisionKitCore.framework, which a plain CLI
    // does not link. dlopen once, then look the classes up.
    private static let analyzerClass: AnyClass? = {
        if let c = NSClassFromString("VKCImageAnalyzer") { return c }
        dlopen(
            "/System/Library/PrivateFrameworks/VisionKitCore.framework/VisionKitCore",
            RTLD_NOW)
        return NSClassFromString("VKCImageAnalyzer")
    }()
    private static let requestClass: AnyClass? =
        NSClassFromString("VKCImageAnalyzerRequest") != nil
        ? NSClassFromString("VKCImageAnalyzerRequest")
        : {
            _ = analyzerClass
            return NSClassFromString("VKCImageAnalyzerRequest")
        }()

    private static var consecutiveFailures = 0
    private static var broken = false
    static var usable: Bool {
        !broken && analyzerClass != nil && requestClass != nil
    }

    private static func failed(_ why: String) {
        consecutiveFailures += 1
        if consecutiveFailures >= 3 { broken = true }
        let state = broken ? "disabled for this session" : "falling back this pass"
        FileHandle.standardError.write(
            "livetext: \(why); \(state)\n".data(using: .utf8)!)
    }

    /// -[obj sel] for a selector returning an ObjC object.
    private static func msg(_ obj: AnyObject, _ sel: String) -> AnyObject? {
        let s = NSSelectorFromString(sel)
        guard obj.responds(to: s) else { return nil }
        return obj.perform(s)?.takeUnretainedValue()
    }

    /// -[quad boundingBox] — struct return, so raw IMP, not perform().
    /// The rect is normalized with a TOP-LEFT origin (ocrmac flips it to get
    /// Vision's bottom-left; we want top-left, so it is used as-is).
    private static func quadBox(_ obj: AnyObject) -> CGRect {
        guard let quad = msg(obj, "quad") else { return .zero }
        let sel = NSSelectorFromString("boundingBox")
        guard let cls: AnyClass = object_getClass(quad),
            let imp = class_getMethodImplementation(cls, sel)
        else { return .zero }
        typealias RectFn = @convention(c) (AnyObject, Selector) -> CGRect
        return unsafeBitCast(imp, to: RectFn.self)(quad, sel)
    }

    private enum Outcome {
        case ok([RecognizedLine])
        case error
        case timeout
    }

    /// One analysis pass over `image`. nil = the engine failed this pass and
    /// the caller must fall back to Vision.
    ///
    /// Async, and necessarily so — measured, not inferred. The completion is
    /// delivered through the main dispatch queue, and this process's main
    /// thread only drains that queue while the main task is SUSPENDED (Swift
    /// async-main). Every synchronous wait tried here failed in the capture
    /// path: a main-thread nested run-loop spin cannot re-enter the
    /// main-queue drain (it only worked pre-first-await, where --image runs);
    /// a dedicated worker thread's loop never sees the completion; a
    /// semaphore blocks the drain outright. Awaiting a continuation is the
    /// one shape that frees the main thread to drain while VisionKit works.
    static func analyze(_ image: CGImage) async -> [RecognizedLine]? {
        guard usable,
            let anaCls: AnyObject = analyzerClass,
            let reqCls: AnyObject = requestClass
        else { return nil }

        let nsImage = NSImage(
            cgImage: image,
            size: NSSize(width: image.width, height: image.height))

        // [[VKCImageAnalyzerRequest alloc] initWithImage:requestType:1]
        // (1 = VKAnalysisTypeText). The scalar argument rules out perform();
        // call the IMP directly.
        guard let reqAlloc = performAlloc(reqCls) else {
            failed("alloc failed")
            return nil
        }
        let initSel = NSSelectorFromString("initWithImage:requestType:")
        guard let reqInstCls: AnyClass = object_getClass(reqAlloc),
            let initImp = class_getMethodImplementation(reqInstCls, initSel)
        else {
            failed("initWithImage:requestType: missing")
            return nil
        }
        typealias InitFn = @convention(c) (AnyObject, Selector, AnyObject, Int) -> AnyObject?
        guard
            let request = unsafeBitCast(initImp, to: InitFn.self)(
                reqAlloc, initSel, nsImage, 1)
        else {
            failed("request init returned nil")
            return nil
        }
        // Same language hint as the Vision path.
        _ = request.perform(
            NSSelectorFromString("setLocales:"),
            with: ["ja-JP", "en-US"] as NSArray)

        guard let anaAlloc = performAlloc(anaCls),
            let analyzer = msg(anaAlloc, "init")
        else {
            failed("analyzer init failed")
            return nil
        }

        // processRequest:progressHandler:completionHandler: — block shapes
        // from ocrmac's hand-declared metadata: progress (double),
        // completion (analysis, error).
        let procSel = NSSelectorFromString("processRequest:progressHandler:completionHandler:")
        guard let anaInstCls: AnyClass = object_getClass(analyzer),
            let procImp = class_getMethodImplementation(anaInstCls, procSel)
        else {
            failed("processRequest selector missing")
            return nil
        }
        typealias ProgressBlk = @convention(block) (Double) -> Void
        typealias CompleteBlk = @convention(block) (AnyObject?, AnyObject?) -> Void
        typealias ProcFn =
            @convention(c)
        (AnyObject, Selector, AnyObject, @escaping ProgressBlk, @escaping CompleteBlk) -> Void

        // Resume-once guard shared by the completion and the watchdog.
        let lock = NSLock()
        var resumed = false
        func firstResume() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if resumed { return false }
            resumed = true
            return true
        }

        let outcome: Outcome = await withCheckedContinuation { cont in
            let complete: CompleteBlk = { analysis, error in
                guard firstResume() else { return }
                if error == nil, let analysis {
                    cont.resume(returning: .ok(extract(analysis)))
                } else {
                    cont.resume(returning: .error)
                }
            }
            unsafeBitCast(procImp, to: ProcFn.self)(
                analyzer, procSel, request, { _ in }, complete)
            // Watchdog: a hung analysis must degrade, not stall the watch loop.
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                guard firstResume() else { return }
                cont.resume(returning: .timeout)
            }
        }

        switch outcome {
        case .ok(let lines):
            // alloc/init handed us +1 refs; the analysis is over, balance them.
            Unmanaged.passUnretained(request).release()
            Unmanaged.passUnretained(analyzer).release()
            consecutiveFailures = 0
            return lines
        case .error:
            Unmanaged.passUnretained(request).release()
            Unmanaged.passUnretained(analyzer).release()
            failed("analysis error")
            return nil
        case .timeout:
            // The analysis may still be running and touch these objects;
            // leaking two small objects on a rare path beats a use-after-free.
            failed("completion timeout")
            return nil
        }
    }

    /// +[cls alloc] via perform (object-returning, so perform is safe).
    private static func performAlloc(_ cls: AnyObject) -> AnyObject? {
        cls.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    }

    /// Walk analysis.allLines() -> line.string()/quad()/children(). Children
    /// are per-character for CJK; latin tokens can be multi-character, whose
    /// box is subdivided evenly so downstream always sees one entry per char.
    private static func extract(_ analysis: AnyObject) -> [RecognizedLine] {
        guard let all = msg(analysis, "allLines") as? [AnyObject] else { return [] }
        var out: [RecognizedLine] = []
        for lineObj in all {
            guard let text = msg(lineObj, "string") as? String, !text.isEmpty
            else { continue }
            var chars: [RecognizedChar] = []
            if let children = msg(lineObj, "children") as? [AnyObject] {
                for c in children {
                    guard let s = msg(c, "string") as? String, !s.isEmpty else { continue }
                    let box = quadBox(c)
                    let n = s.count
                    if n == 1 {
                        chars.append(RecognizedChar(ch: s, box: box))
                    } else {
                        let w = box.width / CGFloat(n)
                        for (i, ch) in s.enumerated() {
                            if String(ch).trimmingCharacters(in: .whitespaces).isEmpty { continue }
                            chars.append(
                                RecognizedChar(
                                    ch: String(ch),
                                    box: CGRect(
                                        x: box.minX + CGFloat(i) * w,
                                        y: box.minY,
                                        width: w, height: box.height)))
                        }
                    }
                }
            }
            out.append(RecognizedLine(text: text, box: quadBox(lineObj), chars: chars))
        }
        return out
    }
}
