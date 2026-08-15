// The two permissions this app needs, and the one thing that can be missing
// besides them.
//
// They fail differently, which is why both are checked and reported: without
// Screen Recording nothing works at all, while without Accessibility the
// global trigger silently never fires and the log stays clean.

const { dialog, shell, systemPreferences } = require('electron');
const { execFileSync } = require('child_process');
const { OCR_BIN: YOMI_BIN } = require('../paths.js');

let hasScreenRecording = true;
let hasAccessibility = true;
let binaryMissingReported = false;
let onChange = () => {};

// yomi is found beside the project directory paths.js resolves, so an
// unbuilt helper (or a bad YOMI_OVERLAY_DIR) means spawn() fails with ENOENT.
// A ChildProcess with no 'error' listener
// rethrows, which would take the whole app down before anything is on screen —
// catch it and say exactly which file to edit.
function reportSpawnFailure(what, err) {
  console.error(`[${what}] could not start yomi: ${err.message}`);
  if (err.code !== 'ENOENT' || binaryMissingReported) return;
  binaryMissingReported = true;
  dialog.showMessageBox({
    type: 'error',
    title: 'yomi not found',
    message: 'Yomi Overlay cannot find its capture helper.',
    detail:
      `Expected it at:\n${YOMI_BIN}\n\n` +
      'Build it with:\n  ocr/build.sh\n\n' +
      'If that path is not where the project lives, the loader resolved the ' +
      'wrong directory — fix ~/Library/Application Support/Yomi Overlay/' +
      'project-path or set YOMI_OVERLAY_DIR.',
    buttons: ['OK'],
  });
}


// the failure is invisible: SCShareableContent stalls, then errors to a log the
// user never sees. Check once at startup and say so plainly.
function checkPermission() {
  try {
    const out = execFileSync(YOMI_BIN, ['--check-permission'], { timeout: 5000 });
    hasScreenRecording = JSON.parse(out.toString()).screenRecording === true;
  } catch (e) {
    // A missing binary is a different problem with a different fix; blaming
    // Screen Recording for it sends the user to the wrong settings pane.
    if (e && e.code === 'ENOENT') { reportSpawnFailure('permission check', e); return; }
    hasScreenRecording = false;
  }
  if (hasScreenRecording) return;

  onChange();
  dialog.showMessageBox({
    type: 'warning',
    title: 'Screen Recording permission needed',
    message: 'Yomi Overlay cannot read the target window.',
    detail:
      'Screen Recording is required to capture the window being read. This is ' +
      'separate from Accessibility (which only powers the Shift/click trigger).\n\n' +
      'System Settings → Privacy & Security → Screen Recording → add ' +
      '"Yomi Overlay", then relaunch.',
    buttons: ['Open System Settings', 'Later'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  });
}

// Accessibility powers the global Shift/click monitor. Without it the monitors
// in yomi --events never fire — silently, by design of the API — and the
// only way to look a word up is Shift *plus mouse movement*. That degradation
// is invisible: the process is running, the log is clean, and Shift simply does
// nothing when held still. Report it the way Screen Recording is reported.
function checkAccessibility() {
  try {
    // false: report only. Passing true pops the system prompt, which for an
    // LSUIElement app appears with no visible owner and reads as a scam.
    hasAccessibility = systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    hasAccessibility = true;      // unknown — don't cry wolf
  }
  if (hasAccessibility) return;
  console.error('[events] Accessibility not granted — the global Shift/click ' +
                'trigger cannot fire. Falling back to Shift + mouse movement.');
  onChange();
}

/** Check both, reporting through the dialogs above. */
function checkAll(notify) {
  onChange = notify || (() => {});
  checkPermission();
  checkAccessibility();
}

module.exports = {
  reportSpawnFailure,
  checkAll,
  get screenRecording() { return hasScreenRecording; },
  get accessibility() { return hasAccessibility; },
};
