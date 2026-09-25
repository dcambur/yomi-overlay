// The menu-bar item. The app is LSUIElement — no Dock icon, no menu bar — so
// this is the only discoverable way in; a global shortcut alone is not
// findable.

const { app, Menu, Tray, shell } = require('electron');
const path = require('path');
const { ASSETS_DIR } = require('../paths.js');
const cfg = require('./config.js');
const permissions = require('./permissions.js');

let tray = null;
let actions = {};

// What capture is doing, in the words the menu uses. The overlay is invisible
// by design — hidden while the target is not on screen, and nothing to see on
// a page until a lookup — so without this line every way it can be idle
// looked the same from outside: Shift over the page, and nothing.
let capture = { state: null };     // until the capture child first starts
let slowTimer = null;
// A first read normally lands in 1-3 s. A helper never run before spends its
// first one compiling Vision's model: 29-64 s, measured (FOUND-BUGS 2).
const SLOW_START_MS = 10000;
// Exits in a row with no good payload between them: a helper that cannot read
// at all, not one that stumbled once (a rebuilt one is refused once, measured).
const FAILING_EXITS = 3;
let exitsInARow = 0;

function captureLine(label) {
  switch (capture.state) {
    case 'starting': return 'Starting capture…';
    case 'slow': return 'Starting capture… the first read after an update takes a minute';
    case 'reading': return `Reading ${label}`;
    case 'away': return `${label} is not on screen`;
    case 'failing': return 'Capture keeps stopping — its reason is in the log';
    case 'unstartable': return 'Capture could not start — its reason is in the log';
    case 'stopped': return 'The overlay stopped after crashing — Restart capture revives it';
    default: return null;
  }
}

/**
 * What capture is doing now: 'starting', 'reading', 'away' (the target has no
 * window on screen), 'unstartable' (the helper could not be spawned),
 * 'stopped' (the overlay page was given up), 'revived' (it was loaded again),
 * or an exit of the capture child. Redraws the menu only when the answer
 * changes.
 */
function setCapture(state) {
  if (state === 'exited') {
    exitsInARow++;
    if (exitsInARow < FAILING_EXITS || capture.state === 'stopped') return;
    state = 'failing';
  }
  if (state === 'reading' || state === 'away') exitsInARow = 0;
  // Only reloading the page ends "stopped": the child restarting on its own —
  // a crash, the watchdog — leaves the page dead, and the menu read "Reading"
  // over it (test/idle).
  if (capture.state === 'stopped' && state !== 'revived') return;
  if (state === 'revived') state = 'starting';
  // A child that keeps stopping is failing until it reads: each backoff
  // restart put "Starting capture…" back for as long as it lived.
  if (capture.state === 'failing' && state === 'starting') return;
  if (state === capture.state) return;
  capture = { state };
  if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
  if (state === 'starting') {
    slowTimer = setTimeout(() => { slowTimer = null; setCapture('slow'); }, SLOW_START_MS);
    if (slowTimer.unref) slowTimer.unref();
  }
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
  const status = captureLine(label);
  if (status) items.push({ label: status, enabled: false }, { type: 'separator' });
  if (!permissions.screenRecording) {
    items.push(
      { label: '⚠ Screen Recording not granted', enabled: false },
      { label: 'Open Privacy settings…', click: () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') },
      { type: 'separator' });
  }
  if (!permissions.accessibility) {
    items.push(
      { label: '⚠ Accessibility not granted — Shift must be held while moving',
        enabled: false },
      { label: 'Open Accessibility settings…', click: () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility') },
      { type: 'separator' });
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    ...items,
    // Until a window is chosen, capture follows the default (Kindle), and the
    // menu must not claim the user picked it.
    { label: cfg.targetChosen() ? `Target: ${label}`
      : 'No window chosen yet — Settings… picks one', enabled: false },
    { label: dicts.length ? `Dictionaries: ${dicts.length} enabled`
      : 'No dictionary — lookups find nothing until one is added', enabled: false },
    { type: 'separator' },
    { label: 'Settings…', accelerator: 'CommandOrControl+Alt+S',
      click: () => actions.onSettings() },
    { label: 'Restart capture', click: () => actions.onRestartCapture() },
    { type: 'separator' },
    { label: 'Quit Yomi Overlay', click: () => app.quit() },
  ]));
}


module.exports = {
  build(handlers) { actions = handlers; buildTray(); },
  refresh: refreshTrayMenu,
  setCapture,
};
