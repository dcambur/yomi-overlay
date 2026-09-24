// The settings window — the app's only ordinary window.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { SETTINGS_DIR, PRELOAD_DIR } = require('../paths.js');

let settingsWin = null;

/**
 * Open the window, or bring it forward. `tab` names the tab to show; it is
 * only honoured as a string, because the tray and app.on('activate') call
 * this with an event or a menu item as the first argument.
 */
function openSettings(tab) {
  const show = typeof tab === 'string' ? tab : null;
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (show) settingsWin.webContents.send('settings:tab', show);
    settingsWin.focus();
    return;
  }
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
  settingsWin.loadFile(path.join(SETTINGS_DIR, 'settings.html'),
                       show ? { query: { tab: show } } : undefined);
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (app.dock) app.dock.hide();
  });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
}

/** Push an event to the settings window, if it is open. */
function sendSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send(channel, payload);
  }
}

module.exports = { openSettings, closeSettings, sendSettings };
