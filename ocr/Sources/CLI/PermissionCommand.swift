// --check-permission: report Screen Recording status and exit.

import Foundation
import CoreGraphics
import ScreenCaptureKit

/// Reports whether Screen Recording has been granted.
///
/// Runs before any ScreenCaptureKit call by design: without the grant
/// SCShareableContent stalls for seconds before failing, which made the
/// settings picker look hung.
func runPermissionCheck() -> Never {
    // CGPreflight does not prompt; it just reports.
    let ok = CGPreflightScreenCaptureAccess()
    print("{\"screenRecording\":\(ok)}")
    exit(ok ? 0 : 3)
}
