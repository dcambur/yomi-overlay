// The candidate windows the settings picker offers.

const { execFile } = require('child_process');
const { OCR_BIN: YOMI_BIN } = require('../paths.js');

/** Every capturable window worth offering as a target. */
function listWindows() {
  return new Promise(resolve => {
    execFile(YOMI_BIN, ['--list-all'], (err, stdout) => {
      if (err) return resolve([]);
      let list = [];
      try { list = JSON.parse(stdout); } catch { return resolve([]); }
      // Never offer our own overlay, and drop helper popovers (autofill
      // panels, notification chrome) that are never a reading surface.
      const skip = new Set([
        'com.github.Electron', 'local.yomioverlay',
        'com.apple.SafariPlatformSupport.Helper',
        'com.apple.notificationcenterui', 'com.apple.controlcenter',
        'com.apple.spotlight', 'com.raycast.macos',
      ]);
      list = list.filter(w =>
        !skip.has(w.bundle) && w.width >= 400 && w.height >= 300);
      list.sort((a, b) => (b.onScreen - a.onScreen) ||
                          a.app.localeCompare(b.app));
      resolve(list);
    });
  });
}

module.exports = { listWindows };
