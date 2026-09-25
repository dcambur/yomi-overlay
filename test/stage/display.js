// The invisible display and the windows a lane puts on it.

const { BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { BIN_DIR } = require(path.join(ROOT, 'app', 'paths.js'));
const { sleep, waitFor, track, lines } = require('./harness.js');
const { listAll } = require('./yomi.js');

const HELPERS = path.join(BIN_DIR, 'test');

let D = null;

async function openDisplay() {
  const child = track(spawn(path.join(HELPERS, 'virtual-display'), [],
                            { stdio: ['pipe', 'pipe', 'inherit'] }));
  const line = await new Promise((resolve, reject) => {
    lines(child.stdout, resolve);
    child.on('exit', (code) => reject(new Error(`virtual-display exited (${code})`)));
  });
  const d = JSON.parse(line);
  // Electron hears about a new display from its own notification, a beat later.
  await waitFor('Electron to see the display',
                () => screen.getAllDisplays().some((s) => s.id === d.id));
  D = { ...d, close: () => child.stdin.end() };
  return D;
}

/** A window on the invisible display; `r` is relative to that display. */
async function stageWindow(page, r, opts = {}) {
  const win = new BrowserWindow({
    x: D.x + r.x, y: D.y + r.y, width: r.width, height: r.height,
    show: false, frame: false, resizable: false, ...opts,
  });
  await (page.startsWith('data:') ? win.loadURL(page) : win.loadFile(page));
  win.showInactive();
  const id = Number(win.getMediaSourceId().split(':')[1]);
  await waitFor(`window ${id} to be composited`,
                () => listAll().some((w) => w.id === id && w.onScreen));
  return { win, id };
}

/**
 * Bring `w` in front of the other stage windows. Not moveTop(): measured, it
 * does not reorder an accessory app's windows at all, where showInactive()
 * does — within 300ms, and there is no z-order to poll without a helper of
 * its own (--list-all is not in z-order).
 */
async function raise(w) {
  w.win.showInactive();
  await sleep(300);
}

const contentOrigin = (w) =>
  w.win.webContents.executeJavaScript('({ sx: screenX, sy: screenY })');

/** Where the window server has the window now. */
const serverRect = (w) => listAll().find((x) => x.id === w.id);

const near = (a, b, tol = 2) =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
module.exports = { openDisplay, stageWindow, raise, contentOrigin, serverRect, near };
