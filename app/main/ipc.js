// Everything the renderer can ask the main process to do.
//
// This is the trust boundary. CONVENTIONS says to treat everything crossing
// IPC as untrusted, and until now nothing did: `lookup` forwarded whatever
// arrived straight into a query loop, and `cfg:save` merged an arbitrary
// object into the file that supplies the capture child's argv.
//
// Nothing here is defending against a hostile renderer — it runs our own code
// behind contextIsolation and a sandbox. It defends against a BUG in that
// code arriving as a shape nobody expected, which is the failure that costs an
// afternoon because it surfaces three layers away.
//
// Rejections are logged once per channel. A silently ignored message is
// exactly the thing that costs the afternoon.

const { ipcMain } = require('electron');
const { logf } = require('./log.js');
const cfg = require('./config.js');
const { lookup } = require('./lookup.js');
const { listWindows } = require('./window-list.js');
const { openSettings, closeSettings } = require('./settings-window.js');

// Lookup scans at most 12 glyphs; the renderer sends the rest of the line.
// A cap well above that is a guard against a runaway payload, not a limit.
const MAX_GLYPHS = 256;
const MAX_TEXT = 512;

const complained = new Set();
function reject(channel, why) {
  if (complained.has(channel)) return null;
  complained.add(channel);
  logf(`[ipc] ${channel}: ignoring a malformed payload — ${why}`);
  return null;
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** The glyph array the renderer sends, or a plain string. */
function validGlyphs(v) {
  if (isStr(v, MAX_TEXT)) return true;
  return Array.isArray(v) && v.length > 0 && v.length <= MAX_GLYPHS &&
         v.every((g) => isStr(g, 8));
}

function register({ overlayWindow, ocrChild, eventsChild, tray }) {
  ipcMain.handle('lookup', (_e, text, hint) => {
    if (!validGlyphs(text)) return reject('lookup', 'text is not a glyph array');
    if (hint != null && !isStr(hint, MAX_TEXT)) return reject('lookup', 'bad hint');
    try { return lookup(text, 12, hint ?? null); } catch { return null; }
  });

  // The renderer grabs the mouse only while the cursor is over the popup, so
  // everything else keeps falling through to the target.
  ipcMain.on('set-interactive', (_e, want) => overlayWindow.setInteractive(!!want));

  ipcMain.handle('cfg:get', () => cfg.load());
  ipcMain.handle('cfg:windows', () => listWindows());

  ipcMain.handle('cfg:save', (_e, next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      reject('cfg:save', 'not an object');
      return cfg.load();
    }
    const before = cfg.trigger();
    // config.js clamps the values it knows; this only guarantees it is handed
    // something object-shaped to merge.
    cfg.save(next);
    tray.refresh();
    overlayWindow.sendTrigger();
    // The modifier is baked into the event monitor's arguments, so a change to
    // it needs a fresh child; mode/delay are renderer-side and do not.
    if (cfg.trigger().modifier !== before.modifier) eventsChild.restart();
    // Retarget: drop the stale glyph layer, then restart capture. The old
    // process must be gone before the new one starts, or both stream payloads
    // and fight over the overlay's bounds.
    overlayWindow.reset();
    ocrChild.restart();
    return cfg.load();
  });

  ipcMain.on('cfg:close', () => closeSettings());
}

module.exports = { register, openSettings, isNum, isStr };
