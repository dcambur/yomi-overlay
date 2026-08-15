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
    { label: `Target: ${label}`, enabled: false },
    { label: `Dictionaries: ${dicts.length} enabled`, enabled: false },
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
};
