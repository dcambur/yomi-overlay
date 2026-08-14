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
const dictionaries = require('./dictionaries.js');
const lookupModule = require('./lookup.js');
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

  // --- dictionaries ---------------------------------------------------
  // Adding or removing one changes the index the overlay reads, so every path
  // here ends the same way: rebuild, reopen, and tell the window what the
  // popup will now show.
  const { sendSettings } = require('./settings-window.js');
  const { dialog } = require('electron');

  async function rebuildAndReopen(what) {
    sendSettings('dict:progress', { phase: 'indexing', name: what });
    const result = await dictionaries.rebuildAsync((p) => {
      sendSettings('dict:progress', { phase: 'indexing', name: p.name,
                                      done: p.done, total: p.total });
    });
    // The handle held since startup points at the old file; drop it so the
    // next lookup opens what was just written.
    lookupModule.close();
    cfg.refreshDictionaries();
    sendSettings('dict:progress', { phase: 'done', labels: result.labels });
    return result;
  }

  ipcMain.handle('dict:catalogue', () => dictionaries.catalogue());
  ipcMain.handle('dict:installed', () => dictionaries.installed());

  ipcMain.handle('dict:download', async (_e, id) => {
    if (!isStr(id, 64)) return reject('dict:download', 'bad id');
    try {
      const got = await dictionaries.download(id, (p) => {
        sendSettings('dict:progress', { phase: 'downloading', ...p });
      });
      await rebuildAndReopen(got.file);
      return { ok: true, file: got.file };
    } catch (e) {
      logf('[dict] download failed: ' + e.message);
      sendSettings('dict:progress', { phase: 'error', message: e.message });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('dict:import', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import a Yomitan dictionary',
      filters: [{ name: 'Yomitan dictionary', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
    const added = [];
    for (const file of picked.filePaths) {
      try { added.push(dictionaries.importFile(file).file); }
      catch (e) {
        logf('[dict] import failed: ' + e.message);
        sendSettings('dict:progress', { phase: 'error', message: e.message });
        return { ok: false, error: e.message };
      }
    }
    await rebuildAndReopen(added.join(', '));
    return { ok: true, added };
  });

  ipcMain.handle('dict:remove', async (_e, file) => {
    if (!isStr(file, 256)) return reject('dict:remove', 'bad file');
    // Work out what the index calls it BEFORE deleting the archive — the label
    // comes from the archive's own title when it is not one we know.
    const entry = dictionaries.installed().find((d) => d.file === file);
    if (!entry) return { ok: false, error: `no such dictionary: ${file}` };
    const label = dictionaries.labelOf(file, entry.kind, entry.name);
    try { dictionaries.remove(file); }
    catch (e) { return { ok: false, error: e.message }; }

    // Delete its rows rather than rebuilding the index around it: ~2.6s
    // against ~80s. An index built before the dict columns existed cannot be
    // pruned and falls back to the rebuild.
    let result;
    try {
      result = await dictionaries.pruneAsync(
        label, (p) => sendSettings('dict:progress', p));
    } catch (e) {
      logf('[dict] prune failed, rebuilding: ' + e.message);
      result = { pruned: false };
    }
    if (!result.pruned) {
      await rebuildAndReopen(file);
      return { ok: true, rebuilt: true };
    }
    const labels = dictionaries.writeManifest();
    lookupModule.close();
    cfg.refreshDictionaries();
    sendSettings('dict:progress', { phase: 'done', labels });
    return { ok: true };
  });

  ipcMain.on('cfg:close', () => closeSettings());
}

module.exports = { register, openSettings, isNum, isStr };
