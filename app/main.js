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

let win = null;
let interactive = false;
let idleTimer = null;
let tray = null;
let hasScreenRecording = true;
// The watch process emits a payload, heartbeat, or idle marker every pass, so
// prolonged TOTAL silence means it wedged — not that the target is off screen.
const OCR_WATCHDOG_MS = 120000;
let binaryMissingReported = false;
let hasAccessibility = true;
// Last target-frame origin sent to the renderer, so it is only resent when it
// actually changes rather than on every capture.
let lastOffset = { fx: NaN, fy: NaN };
// Same, for the regions other windows are drawn over the target — compared as
// a signature because the value is a list.
let lastCovers = '';

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


// The panel joins every Space (that is what lets it float over the target's
// fullscreen Space), so it would otherwise follow you onto desktops with no
// target on them — which is exactly what it did, for eight seconds at a time,
// while this timeout was the ONLY thing that hid it.
//
// It is no longer that. "The target is not visible" now arrives as a
// measurement — the watcher's `idle` marker, emitted between passes — and is
// acted on immediately below. What is left here is the backstop for SILENCE:
// a watcher that stopped producing anything at all.
//
// 8s, not 3.5s: an engine-probe + orientation-probe OCR pass produces no
// payload for up to ~9s (measured on game targets, /tmp/yomi-overlay.log
// 2026-08-09 20:13:16→20:13:25), and every false hide silently eats the
// Shift presses that arrive while hidden — 239 hide events in one log,
// most of them mid-session flapping.
const IDLE_HIDE_MS = 8000;

function hideOverlay(why) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.hide();
  // Hiding the panel takes the popup off screen but not out of the renderer's
  // state: it stays pinned, and the next time the target reappears it is back
  // — anchored to a word that may since have scrolled away.
  win.webContents.send('dismiss');
  console.log('[win] hidden — ' + why);
}

function noteActivity(win) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => hideOverlay(`no capture for ${IDLE_HIDE_MS}ms`),
                         IDLE_HIDE_MS);
}

// The panel covers a whole display and never tracks the target window.
//
// It used to be moved to the target's frame on every capture, with a measured
// "how far off did macOS actually place us" correction — but moves are applied
// asynchronously, panels get placed somewhere other than asked, and getBounds()
// can report a position the window server never applied. Every one of those is
// a race that displaces the glyph layer by exactly the discrepancy (the
// recurring ~60px vertical drift). A display-sized panel is set up once;
// glyphs are positioned at target-frame + glyph-coords, both taken from the
// same OCR payload, so they cannot disagree.
function ensureCover(frame) {
  const d = screen.getDisplayMatching(frame);
  const b = win.getBounds();
  const db = d.bounds;
  if (b.x !== db.x || b.y !== db.y || b.width !== db.width || b.height !== db.height) {
    win.setBounds(db);
    console.log(`[win] covering display ${db.x},${db.y} ${db.width}x${db.height}`);
  }
  return db;
}

function createWindow() {
  win = new BrowserWindow({
    ...screen.getPrimaryDisplay().bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    // Without this macOS clamps a display-sized window to the work area
    // (below the menu bar, above the Dock), and every clamp displaces the
    // glyph layer by the clamped amount.
    enableLargerThanScreen: true,
    show: false,              // stay hidden until the target is located
    focusable: false,         // keyboard focus stays with the target
    skipTaskbar: true,
    // NSPanel, not NSWindow. A plain window can join all ordinary desktops
    // but never enters another app's fullscreen Space — it just sits on the
    // desktop behind it. A non-activating panel is what actually floats over
    // a fullscreen app.
    type: 'panel',
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Must outrank the menu bar: at 'floating' a y=0 request is clamped to
  // y=30, which offsets the whole glyph layer against a fullscreen target.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
  // Don't let macOS treat the overlay itself as fullscreen-capable.
  win.setFullScreenable(false);
  // forward:true — the renderer sees mousemove (so hover works) while clicks
  // and scroll fall through to the target underneath.
  win.setIgnoreMouseEvents(true, { forward: true });
  // Electron 36+ passes a details object; the old positional arguments are
  // deprecated and warn on every launch.
  win.webContents.on('console-message', ({ message, lineNumber }) => {
    console.log(`[renderer] ${message}` + (lineNumber ? ` (line ${lineNumber})` : ''));
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[renderer] load failed ${code}: ${desc}`);
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error(`[renderer] preload error in ${p}: ${err}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log('[renderer] loaded');
    sendTrigger();
  });
  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
}

/** Push trigger settings to the renderer, which does the modifier test itself. */
function sendTrigger() {
  if (!win || win.isDestroyed()) return;
  const t = cfg.trigger();
  win.webContents.send('trigger-config', t);
  console.log(`[trigger] ${t.mode === 'hover'
    ? `hover (${t.hoverDelayMs}ms dwell)` : t.modifier + ' + point'}`);
}

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
  if (payload.idle) { hideOverlay('target has no visible window'); return; }
  if (!payload.frame) return;
  ocrChild.resetBackoff();   // a good payload means the process is healthy

  const f = payload.frame;
  if (win) {
    // Pin the panel to the display the target lives on. This moves only
    // when the target changes displays — never per-frame.
    const db = ensureCover(f);
    if (!win.isVisible()) {
      win.showInactive();
      // Re-apply after showing. Set only at creation time, macOS commonly
      // drops the fullscreen-auxiliary collection behaviour, and the window
      // then lands on the ordinary desktop instead of over the target's
      // fullscreen Space.
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
      win.setAlwaysOnTop(true, 'screen-saver');
      console.log('[win] shown; allWorkspaces=' + win.isVisibleOnAllWorkspaces());
    }
    noteActivity(win);

    // Tell the renderer where the target window is, in absolute screen
    // coordinates. The renderer subtracts its OWN actual position
    // (window.screenX/Y) — not the position we asked for — so whatever
    // macOS did to the panel (clamp, async move, refusal) cancels out.
    // Shipped on every pass, heartbeats included, because the target
    // window can move while its content stays unchanged.
    if (f.x !== lastOffset.fx || f.y !== lastOffset.fy) {
      lastOffset = { fx: f.x, fy: f.y };
      win.webContents.send('offset', lastOffset);
      const pb = win.getBounds();
      console.log(`[win] target frame ${f.x},${f.y} ${f.width}x${f.height} ` +
                  `| panel bounds ${pb.x},${pb.y} ${pb.width}x${pb.height}`);
    }

    // Which parts of the target another window is drawn over, in the same
    // frame-local points as the glyph boxes. Shipped on every pass,
    // heartbeats included: capture excludes other windows, so a window can
    // be dragged over the reader without one pixel of the payload changing
    // — and the renderer must stop hit-testing the glyphs underneath it
    // the moment that happens.
    const covers = Array.isArray(payload.covers) ? payload.covers : [];
    const csig = JSON.stringify(covers);
    if (csig !== lastCovers) {
      lastCovers = csig;
      win.webContents.send('covers', covers);
      console.log(`[win] covered by ${covers.length} window(s)`);
    }

    // A heartbeat means the page is unchanged: keep the window alive,
    // tracking and aligned, but don't hand the renderer an empty line set —
    // that would wipe the glyph layer it is still using.
    if (payload.unchanged) return;

    win.webContents.send('capture', payload);
  }
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
  if (!win || !win.isVisible()) return;
  const b = win.getBounds();
  // Screen coords -> window-local, which is what the glyph layer uses.
  const x = ev.x - b.x, y = ev.y - b.y;
  if (x < 0 || y < 0 || x > b.width || y > b.height) return;
  win.webContents.send('trigger', { type: ev.type, x, y });
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
ipcMain.on('set-interactive', (_e, want) => {
  if (!win || want === interactive) return;
  interactive = want;
  if (want) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
});

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
  buildTray();
  checkPermission();
  checkAccessibility();
  createWindow();
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
// the failure is invisible: SCShareableContent stalls, then errors to a log the
// user never sees. Check once at startup and say so plainly.
function checkPermission() {
  const { execFileSync } = require('child_process');
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

  refreshTrayMenu();
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
  refreshTrayMenu();
}

function buildTray() {
  const icon = path.join(ASSETS_DIR, 'trayTemplate.png');
  tray = new Tray(icon);
  tray.setToolTip('Yomi Overlay');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const t = cfg.load().target || {};
  const label = t.label || t.bundle || 'not set';
  const dicts = cfg.enabledDictionaries();
  const items = [];
  if (!hasScreenRecording) {
    items.push(
      { label: '⚠ Screen Recording not granted', enabled: false },
      { label: 'Open Privacy settings…', click: () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') },
      { type: 'separator' });
  }
  if (!hasAccessibility) {
    items.push(
      { label: '⚠ Accessibility not granted — Shift must be held while moving',
        enabled: false },
      { label: 'Open Accessibility settings…', click: () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { type: 'separator' });
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    ...items,
    { label: `Target: ${label}`, enabled: false },
    { label: `Dictionaries: ${dicts.length} enabled`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', accelerator: 'CommandOrControl+Alt+S', click: openSettings },
    { label: 'Restart capture', click: () => ocrChild.restart() },
    { type: 'separator' },
    { label: 'Quit Yomi Overlay', click: () => app.quit() },
  ]));
}


ipcMain.handle('cfg:get', () => cfg.load());

ipcMain.handle('cfg:windows', () => listWindows());

ipcMain.handle('cfg:save', (_e, next) => {
  const before = cfg.trigger();
  cfg.save(next);
  refreshTrayMenu();
  sendTrigger();
  // The modifier is baked into the event monitor's arguments, so a change to it
  // needs a fresh child; mode/delay are renderer-side and do not.
  if (cfg.trigger().modifier !== before.modifier) {
    eventsChild.restart();
  }
  // Retarget: drop the stale glyph layer, then restart capture. The old
  // process must be gone before the new one starts, or both stream payloads
  // and fight over the overlay's bounds.
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) win.hide();
    win.webContents.send('reset');
  }
  // The new target sits somewhere else, so the old placement describes
  // nothing. Forcing a resend also stops the dedupe above from suppressing a
  // frame that happens to equal the stale one.
  lastOffset = { fx: NaN, fy: NaN };
  lastCovers = '';
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
