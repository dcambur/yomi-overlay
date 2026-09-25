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
const { createQueue } = require('./job-queue.js');
const media = require('./media.js');
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

// What the popup sends for one Anki note (docs/ANKI.md). The definitions are
// HTML the renderer built from what it drew; they go into the user's own
// collection, so only their size is bounded here.
const MAX_FIELD = 256 * 1024;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
function validNote(n) {
  if (!n || typeof n !== 'object') return false;
  if (!isStr(n.expression, 64) || !n.expression) return false;
  if (n.reading != null && !isStr(n.reading, 64)) return false;
  if (n.sentence != null && !isStr(n.sentence, 8192)) return false;
  if (n.glossary != null && !isStr(n.glossary, MAX_FIELD)) return false;
  if (n.mainDefinition != null && !isStr(n.mainDefinition, MAX_FIELD)) return false;
  const shortList = (v, ok) => Array.isArray(v) && v.length <= 8 && v.every(ok);
  if (n.pitch != null && !shortList(n.pitch, Number.isInteger)) return false;
  if (n.freq != null &&
      !shortList(n.freq, (f) => f && isStr(f.source, 64) && finite(f.value))) return false;
  if (n.region != null) {
    const r = n.region;
    if (!r || typeof r !== 'object' || ![r.x, r.y, r.w, r.h].every(finite)) return false;
    if (!(r.w > 0 && r.h > 0 && r.w < 8000 && r.h < 8000)) return false;
  }
  return true;
}

function register({ overlayWindow, ocrChild, eventsChild, tray, anki }) {
  ipcMain.handle('lookup', (_e, text, hint) => {
    if (!validGlyphs(text)) return reject('lookup', 'text is not a glyph array');
    if (hint != null && !isStr(hint, MAX_TEXT)) return reject('lookup', 'bad hint');
    try { return lookup(text, 12, hint ?? null); } catch { return null; }
  });

  // The renderer grabs the mouse only while the cursor is over the popup, so
  // everything else keeps falling through to the target.
  ipcMain.on('set-interactive', (_e, want) => overlayWindow.setInteractive(!!want));

  ipcMain.handle('cfg:get', () => {
    // Re-read first. The index can change without this process doing it — a
    // rebuild from the command line, a second window, a restore from backup —
    // and the config's list of dictionaries is bounded by the manifest, so a
    // cached copy silently drops every dictionary whose label the rebuild
    // changed. In the settings window that shows up as a row with no checkbox
    // and no arrows, which looks exactly like a dictionary that failed to
    // index.
    cfg.refreshDictionaries();
    return cfg.load();
  });
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

  // How a lookup fires. Like the dictionaries below, this is saved as it
  // changes rather than behind a button — mode and hover delay are renderer
  // state and apply the moment they are pushed. The modifier is the one
  // exception: it is baked into the event monitor's argv, so THAT child (not
  // the capture child, and not the overlay) is restarted when it changes.
  ipcMain.handle('cfg:trigger', (_e, next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      reject('cfg:trigger', 'not an object');
      return cfg.load();
    }
    const before = cfg.trigger();
    cfg.save({ trigger: next });
    tray.refresh();
    overlayWindow.sendTrigger();
    if (cfg.trigger().modifier !== before.modifier) eventsChild.restart();
    return cfg.load();
  });

  // What the popup draws. Like the trigger, this needs nothing restarted: the
  // overlay is told and the next popup is drawn the new way.
  ipcMain.handle('cfg:view', (_e, next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      reject('cfg:view', 'not an object');
      return cfg.load();
    }
    cfg.save({ images: !!next.images });
    overlayWindow.sendTrigger();
    return cfg.load();
  });

  // Which dictionaries are on, and in what order. Deliberately NOT cfg:save:
  // that one restarts the capture and event children, because the target
  // window and the modifier are baked into their argv. Neither is affected by
  // a dictionary, and lookup.js re-reads the order on every lookup
  // (refreshOrder), so writing the file IS the apply — which is what lets the
  // settings window make these changes live instead of behind a button.
  ipcMain.handle('cfg:dictionaries', (_e, list) => {
    if (!Array.isArray(list)) {
      reject('cfg:dictionaries', 'not an array');
      return cfg.load();
    }
    cfg.save({ dictionaries: list });
    return cfg.load();
  });

  // --- Anki -------------------------------------------------------------
  // Settings saves live, like the trigger: the overlay is told, and the next
  // popup draws its card marks or stops drawing them. Nothing restarts.
  ipcMain.handle('cfg:anki', (_e, next) => {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      reject('cfg:anki', 'not an object');
      return cfg.load();
    }
    cfg.save({ anki: next });
    overlayWindow.sendTrigger();
    return cfg.load();
  });
  ipcMain.handle('anki:status', () => anki.status());

  ipcMain.handle('anki:find', (_e, words) => {
    if (!Array.isArray(words) || !words.length || words.length > 16
        || !words.every((w) => isStr(w, 64) && w)) {
      return reject('anki:find', 'not a list of words');
    }
    return anki.find(words);
  });
  ipcMain.handle('anki:add', (_e, note) => {
    if (!validNote(note)) return reject('anki:add', 'not a note');
    return anki.add(note);
  });
  ipcMain.handle('anki:remove', (_e, noteId) => {
    if (!isNum(noteId)) return reject('anki:remove', 'not a note id');
    return anki.remove(noteId);
  });
  // Settings' "Install Lapis": the note type, fetched from its project at a
  // pinned tag and made with createModel (anki.js says why not the .apkg).
  ipcMain.handle('anki:install', () => anki.installLapis());
  // A card mark that cannot make a card ("no Lapis", "no deck") opens the
  // place where that is fixed.
  ipcMain.on('settings:open', (_e, tab) => {
    if (tab !== 'anki') return reject('settings:open', 'unknown tab');
    openSettings(tab);
  });

  // --- dictionaries ---------------------------------------------------
  // Adding or removing one changes the index the overlay reads, so every path
  // here ends the same way: rebuild, reopen, and tell the window what the
  // popup will now show.
  const { sendSettings } = require('./settings-window.js');
  const { dialog } = require('electron');

  // Dictionary work is serialized: these jobs all write one index. See
  // job-queue.js for why that cannot be the settings window's job.
  const enqueue = createQueue((p) => sendSettings('dict:progress', p));

  async function rebuildAndReopen(what, report = () => {}) {
    report({ phase: 'indexing', name: what });
    const result = await dictionaries.rebuildAsync((p) => {
      report({ phase: 'indexing', name: p.name, done: p.done, total: p.total });
    });
    // The handle held since startup points at the old file; drop it so the
    // next lookup opens what was just written.
    lookupModule.close();
    cfg.refreshDictionaries();
    // The media handler holds archives open to serve images out of them; a
    // rebuild can have replaced or removed any of them.
    media.forget();
    report({ phase: 'done', labels: result.labels });
    return result;
  }

  ipcMain.handle('dict:catalogue', () => dictionaries.catalogue());
  ipcMain.handle('dict:installed', () => dictionaries.installed());

  ipcMain.handle('dict:download', async (_e, id) => {
    if (!isStr(id, 64)) return reject('dict:download', 'bad id');
    const entry = dictionaries.catalogue().find((c) => c.id === id);
    return enqueue(entry ? entry.label : id, async (report) => {
      try {
        const got = await dictionaries.download(id, (p) => {
          report({ phase: 'downloading', ...p });
        });
        await rebuildAndReopen(got.file, report);
        return { ok: true, file: got.file };
      } catch (e) {
        logf('[dict] download failed: ' + e.message);
        report({ phase: 'error', message: e.message });
        return { ok: false, error: e.message };
      }
    });
  });

  ipcMain.handle('dict:import', async (_e, job) => {
    const picked = await dialog.showOpenDialog({
      title: 'Import a Yomitan dictionary',
      filters: [{ name: 'Yomitan dictionary', extensions: ['zip'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
    // The dialog is opened BEFORE queueing, because it needs the user now; the
    // copying and the rebuild are what wait their turn. The window names the
    // job, so two imports asked for in a row are two jobs and not one.
    return enqueue(isStr(job, 64) ? job : 'import:1', async (report) => {
      const { added, failed } = dictionaries.importFiles(picked.filePaths);
      for (const f of failed) logf(`[dict] import failed: ${f.file}: ${f.error}`);
      // Index whatever DID land, even if something else did not. Returning
      // early left the archives already copied on disk and out of the index.
      if (added.length) {
        try {
          await rebuildAndReopen(added.map((a) => a.file).join(', '), report);
        } catch (e) {
          // A rejection here reached the window as an exception nobody
          // caught: the row stayed busy and nothing said why.
          logf('[dict] import build failed: ' + e.message);
          report({ phase: 'error', message: e.message });
          return { ok: false, added, failed, error: e.message };
        }
      }
      if (failed.length) {
        const names = failed.map((f) => f.file).join(', ');
        const why = failed[0].error;
        report({ phase: 'error', message: `${names}: ${why}` });
        return { ok: added.length > 0, added, failed, error: `${names}: ${why}` };
      }
      return { ok: true, added };
    });
  });

  ipcMain.handle('dict:remove', async (_e, file) => {
    if (!isStr(file, 256)) return reject('dict:remove', 'bad file');
    // Work out what the index calls it BEFORE deleting the archive — the label
    // comes from the archive's own title when it is not one we know.
    const entry = dictionaries.installed().find((d) => d.file === file);
    if (!entry) return { ok: false, error: `no such dictionary: ${file}` };
    const label = dictionaries.labelOf(file, entry.kind, entry.name);
    return enqueue(label, async (report) => {
      try { dictionaries.remove(file); }
      catch (e) { return { ok: false, error: e.message }; }

      // Delete its rows rather than rebuilding the index around it: ~2.6s
      // against ~80s. An index built before the dict columns existed cannot be
      // pruned and falls back to the rebuild.
      let result;
      try {
        result = await dictionaries.pruneAsync(label, report);
      } catch (e) {
        logf('[dict] prune failed, rebuilding: ' + e.message);
        result = { pruned: false };
      }
      if (!result.pruned) {
        try {
          await rebuildAndReopen(file, report);
        } catch (e) {
          logf('[dict] rebuild after remove failed: ' + e.message);
          report({ phase: 'error', message: e.message });
          return { ok: false, error: e.message };
        }
        return { ok: true, rebuilt: true };
      }
      const labels = dictionaries.writeManifest();
      lookupModule.close();
      cfg.refreshDictionaries();
      media.forget();
      report({ phase: 'done', labels });
      return { ok: true };
    });
  });

  ipcMain.on('cfg:close', () => closeSettings());
}

module.exports = { register, openSettings, isNum, isStr };
