// Transparent overlay pinned to the target window, carrying an invisible
// text layer positioned over the real glyphs. Hold Shift and point at a word.
//
// Scoping: yomi only ever captures the target window (see ocr/Sources/).
// This process renders on top of it and never reads any other window.

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, shell,
        systemPreferences, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { lookup, open: openDict, initTransformer } = require('./main/lookup.js');
const { SupervisedChild } = require('./main/supervised-child.js');
const { logf } = require('./main/log.js');
const { listWindows } = require('./main/window-list.js');
const { openSettings, closeSettings } = require('./main/settings-window.js');
const { createTier2 } = require('./main/tier2.js');
const overlayWindow = require('./main/overlay-window.js');
const permissions = require('./main/permissions.js');
const { reportSpawnFailure } = permissions;
const tray = require('./main/tray.js');

logf('--- launch, argv=' + process.argv.slice(1).join(' ') +
     ' RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE || 'unset'));
const cfg = require('./main/config.js');

const { OCR_BIN: YOMI_BIN, RENDERER_DIR, SETTINGS_DIR, PRELOAD_DIR,
        ASSETS_DIR, TOOLS_DIR, VENV_DIR } = require('./paths.js');

// Shown in the app switcher and menu bar instead of "Electron".
app.setName('Yomi Overlay');

// Without a lock every launch stacks another instance, and they fight over the
// same target window while each spawning their own capture and event monitors.
if (!app.requestSingleInstanceLock()) {
  logf('single-instance lock refused — another instance is running; exiting');
  app.quit();
  // Not process.exit() — that skips app.quit()'s teardown. But we must still
  // stop here: falling through reaches app.whenReady() and spawns a second
  // capture pair, which is exactly what the lock exists to prevent. The log
  // above is already on disk (appendFileSync), so nothing is truncated.
  return;
}
app.on('second-instance', () => {
  // A second launch is a request to configure, not to run twice.
  openSettings();
});
const INTERVAL = process.env.INTERVAL || String(cfg.load().interval || 0.6);

// The watch process emits a payload, heartbeat, or idle marker every pass, so
// prolonged TOTAL silence means it wedged — not that the target is off screen.
const OCR_WATCHDOG_MS = 120000;
// Last target-frame origin sent to the renderer, so it is only resent when it

/**
 * One line of NDJSON from the capture child: payload, heartbeat, idle marker
 * or crop reply. The whole overlay is driven from here.
 */
function onOcrLine(payload) {
  if (payload.crop) { onCropReply(payload.crop); return; }
  // Idle marker: the target has no window the watcher can see — you swiped
  // to another Space, or another window came up over the reader. Hide NOW.
  // This is not the silence IDLE_HIDE_MS is about: it is a measurement,
  // taken between passes (~150ms), that the overlay is currently painted
  // over something that is not the target. Waiting it out is what left the
  // glyph layer and an open popup sitting on the app you switched to.
  // Still proof the watch loop is alive, which is what the watchdog needs.
  if (payload.idle) { overlayWindow.hide('target has no visible window'); return; }
  if (!payload.frame) return;
  ocrChild.resetBackoff();   // a good payload means the process is healthy

  overlayWindow.trackTarget(payload.frame, payload.covers);

  // A heartbeat means the page is unchanged: keep the panel alive, tracking
  // and aligned, but don't hand the renderer an empty line set — that would
  // wipe the glyph layer it is still using.
  if (payload.unchanged) return;
  overlayWindow.send('capture', payload);
}

const ocrChild = new SupervisedChild({
  name: 'ocr',
  bin: YOMI_BIN,
  // Built per spawn, so a settings change lands on the next start with no
  // extra plumbing.
  args: () => {
    const conf = cfg.load();
    const voting = conf.voting || {};
    console.log('[ocr] target: ' + (cfg.targetArgs().join(' ') || '(default)'));
    return ['--json', '--watch', '--interval', INTERVAL,
      '--engine', conf.engine || 'auto',
      '--votes', String(voting.passes ?? 3),
      '--vote-every', String(voting.everyN ?? 2),
      ...cfg.targetArgs()];
  },
  backoff: { initial: 1000, max: 30000, factor: 2 },
  watchdog: { silenceMs: OCR_WATCHDOG_MS, checkMs: 30000 },
  exitHint: 'its stderr above says why (revoked Screen Recording is one cause)',
  onLine: onOcrLine,
  onStderr: (text) => {
    const t = text.trim();
    // Capture failures are expected while another Space is active; only the
    // first of a run is interesting. logf, not process.stderr: launched from
    // Spotlight stderr goes nowhere, and engine/vote diagnostics were
    // invisible exactly when needed.
    if (/failed \(1x/.test(t) || !/failed \(/.test(t)) logf(`[ocr] ${t}`);
  },
  onSpawnError: (err) => reportSpawnFailure('ocr', err),
  log: (m) => console.log(m),
  logError: (m) => console.error(m),
});

// Global Shift / click monitor. Lets a lookup fire without the cursor having
// to move — the overlay itself can only see forwarded mouse-move messages.
/** A global modifier press or click, already in screen coordinates. */
function onTriggerEvent(ev) {
  if (!overlayWindow.isVisible()) return;
  const b = overlayWindow.bounds();
  // Screen coords -> window-local, which is what the glyph layer uses.
  const x = ev.x - b.x, y = ev.y - b.y;
  if (x < 0 || y < 0 || x > b.width || y > b.height) return;
  overlayWindow.send('trigger', { type: ev.type, x, y });
}

const { onCropReply } = createTier2({ ocrChild });

// Global modifier / click monitor. Lets a lookup fire without the cursor
// having to move — the overlay itself can only see forwarded mouse-move
// messages.
const eventsChild = new SupervisedChild({
  name: 'events',
  bin: YOMI_BIN,
  args: () => ['--events', '--modifier', cfg.trigger().modifier],
  // Flat 2s rather than escalating: the monitor either has Accessibility or
  // it does not, so there is nothing for a growing backoff to wait out.
  backoff: { initial: 2000, max: 2000, factor: 1 },
  onLine: onTriggerEvent,
  onStderr: (t) => process.stderr.write('[events] ' + t),
  onSpawnError: (err) => reportSpawnFailure('events', err),
  log: (m) => console.log(m),
  logError: (m) => console.error(m),
});


ipcMain.handle('lookup', (_e, text, hint) => {
  try { return lookup(text, 12, hint); } catch (e) { return null; }
});

// The renderer grabs the mouse only while the cursor is over the popup, so
// everything else keeps falling through to the target.
ipcMain.on('set-interactive', (_e, want) => overlayWindow.setInteractive(want));

app.on('will-quit', () => logf('will-quit'));
app.on('before-quit', () => logf('before-quit'));

app.whenReady().then(() => {
  logf('app ready');
  // The bundle's LSUIElement hides the Dock tile for packaged launches, but
  // macOS can still surface one (dev launches are regular apps; some window
  // states re-show it) — and that tile did nothing when clicked. Enforce
  // menu-bar-only at runtime; openSettings() shows the tile only while the
  // settings window is open. Any Dock click that reaches us means "open
  // settings" — the same meaning second-instance already has.
  if (app.dock) app.dock.hide();
  app.on('activate', openSettings);
  if (!openDict()) {
    console.error('No dictionary index. Run: python3 build-index.py');
  }
  // Yomitan's deinflector is ESM — load before the first hover can arrive.
  initTransformer()
    .then(() => console.log('deinflector: Yomitan japanese-transforms loaded'))
    .catch(e => console.error('deinflector failed to load:', e.message));
  tray.build({
    onSettings: openSettings,
    onRestartCapture: () => ocrChild.restart(),
  });
  permissions.checkAll(() => tray.refresh());
  overlayWindow.create();
  ocrChild.start();
  eventsChild.start();


  // The app is LSUIElement (no Dock icon, no menu bar), so a global shortcut is
  // the only way in. Cmd+Opt+S anywhere opens settings. Registration fails
  // silently if another app already owns the combination — say so, because the
  // tray menu is then the only remaining entry point.
  if (!globalShortcut.register('CommandOrControl+Alt+S', openSettings)) {
    console.error('[shortcut] ⌘⌥S is taken by another app — use the 読 menu-bar item');
  }

  // First run: no config yet, so open settings rather than silently defaulting
  // to Kindle — the target is the one thing the user must choose.
  if (!require('fs').existsSync(cfg.CONFIG_PATH)) openSettings();
});

// The app has no Dock icon and no menu bar (LSUIElement), so the menu-bar item
// is the only discoverable way in — a global shortcut alone is not findable.
// Screen Recording is required for every capture. Without it nothing works and


ipcMain.handle('cfg:get', () => cfg.load());

ipcMain.handle('cfg:windows', () => listWindows());

ipcMain.handle('cfg:save', (_e, next) => {
  const before = cfg.trigger();
  cfg.save(next);
  tray.refresh();
  overlayWindow.sendTrigger();
  // The modifier is baked into the event monitor's arguments, so a change to it
  // needs a fresh child; mode/delay are renderer-side and do not.
  if (cfg.trigger().modifier !== before.modifier) {
    eventsChild.restart();
  }
  // Retarget: drop the stale glyph layer, then restart capture. The old
  // process must be gone before the new one starts, or both stream payloads
  // and fight over the overlay's bounds.
  overlayWindow.reset();
  ocrChild.restart();
  return cfg.load();
});

ipcMain.on('cfg:close', () => closeSettings());

app.on('window-all-closed', () => { /* overlay is headless; keep running */ });

// yomi does not die with its parent, so an unclean shutdown would leave
// two processes capturing the screen with no UI left to stop them. 'quit' alone
// misses SIGINT/SIGTERM (a terminal ^C, Activity Monitor, a logout).
function killChildren() {
  ocrChild.stop();
  eventsChild.stop();
}
app.on('before-quit', killChildren);
app.on('quit', killChildren);
app.on('will-quit', () => globalShortcut.unregisterAll());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killChildren();
    // Handling the signal replaces Node's default "terminate", so a stalled
    // app.quit() — an open modal, a window that won't close — would leave a
    // process nothing but SIGKILL can stop. Guarantee the exit either way.
    setTimeout(() => process.exit(0), 1500);
    app.quit();
  });
}
