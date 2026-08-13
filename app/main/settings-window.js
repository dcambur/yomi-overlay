// The settings window — the app's only ordinary window.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { SETTINGS_DIR, PRELOAD_DIR } = require('../paths.js');

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  // Settings is the app's only regular window. Give it a Dock presence and
  // real focus while it is open — an accessory app's window otherwise opens
  // behind the frontmost app — and drop back to menu-bar-only on close.
  if (app.dock) app.dock.show();
  settingsWin = new BrowserWindow({
    width: 560, height: 520, title: 'Overlay Settings',
    webPreferences: {
      preload: path.join(PRELOAD_DIR, 'settings.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  app.focus({ steal: true });
  settingsWin.webContents.on('console-message', ({ message }) =>
    console.log('[settings] ' + message));
  settingsWin.webContents.on('preload-error', (_e, _p, err) =>
    console.error('[settings] preload error: ' + err));
  settingsWin.loadFile(path.join(SETTINGS_DIR, 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (app.dock) app.dock.hide();
  });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

module.exports = { openSettings, closeSettings };
