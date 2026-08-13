// The transparent panel and everything that decides what the renderer sees.
//
// Five module-scope variables lived in main.js for this one window: the
// window itself, whether the mouse is currently captured, the idle timer, and
// the last offset and cover signature sent to the renderer. They are one
// object's state.

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { RENDERER_DIR, PRELOAD_DIR } = require('../paths.js');
const cfg = require('./config.js');

let win = null;
let interactive = false;
let idleTimer = null;
// Last target-frame origin sent to the renderer, so it is only resent when it
// actually changes rather than on every capture.
let lastOffset = { fx: NaN, fy: NaN };
// Same, for the regions other windows are drawn over the target — compared as
// a signature because the value is a list.
let lastCovers = '';

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

function noteActivity() {
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

/**
 * A payload arrived and the target is on screen: make sure the panel is up,
 * on the right display, and told where the target is.
 */
function trackTarget(frame, covers) {
  if (!win) return;
  ensureCover(frame);
  if (!win.isVisible()) {
    win.showInactive();
    // Re-apply after showing. Set only at creation time, macOS commonly drops
    // the fullscreen-auxiliary collection behaviour, and the window then lands
    // on the ordinary desktop instead of over the target's fullscreen Space.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    console.log('[win] shown; allWorkspaces=' + win.isVisibleOnAllWorkspaces());
  }
  noteActivity();

  // Shipped on every pass, heartbeats included: the target window can move,
  // and can be covered or uncovered, while its content stays unchanged. The
  // renderer subtracts its OWN actual position, so whatever macOS did to the
  // panel cancels out.
  if (frame.x !== lastOffset.fx || frame.y !== lastOffset.fy) {
    lastOffset = { fx: frame.x, fy: frame.y };
    win.webContents.send('offset', lastOffset);
    const pb = win.getBounds();
    console.log(`[win] target frame ${frame.x},${frame.y} ` +
                `${frame.width}x${frame.height} | panel bounds ` +
                `${pb.x},${pb.y} ${pb.width}x${pb.height}`);
  }
  const list = Array.isArray(covers) ? covers : [];
  const csig = JSON.stringify(list);
  if (csig !== lastCovers) {
    lastCovers = csig;
    win.webContents.send('covers', list);
    console.log(`[win] covered by ${list.length} window(s)`);
  }
}

/** The renderer grabs the mouse only while the cursor is over the popup. */
function setInteractive(want) {
  if (!win || want === interactive) return;
  interactive = want;
  if (want) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

/** Retarget: the glyph layer describes a window we no longer track. */
function reset() {
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) win.hide();
    win.webContents.send('reset');
  }
  // The new target sits somewhere else, so the old placement describes
  // nothing. Forcing a resend also stops the dedupe above from suppressing a
  // frame that happens to equal the stale one.
  lastOffset = { fx: NaN, fy: NaN };
  lastCovers = '';
}

module.exports = {
  create: createWindow,
  sendTrigger,
  hide: hideOverlay,
  trackTarget,
  setInteractive,
  reset,
  send: (channel, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...a); },
  get window() { return win; },
  isVisible: () => !!win && !win.isDestroyed() && win.isVisible(),
  bounds: () => (win ? win.getBounds() : null),
};
