// The real app, started through this file instead of its own package.json, so
// a lane can see what the app shows the user without the user seeing it. Test
// code, never shipped; the app's own code is unchanged.
//
//   electron test/stage/in-app.js      (stage/app.js launchApp starts it)
//
// What the app would put in front of the user is recorded and answered here:
// the menu-bar item (a Tray that draws nothing), message boxes, links it opens
// (System Settings panes), focus it would steal, the global shortcut it would
// take. Windows other than the overlay panel open inactive on the invisible
// display. Electron's exports are non-configurable getters (measured), so the
// app's modules get a proxy of the module instead, through Module._load.
//
// fd 3 carries JSON lines: {id, code} in, {id, ok, value | error} out. The
// code runs in the main process with `require`, `rec` (what was recorded),
// `clock` and `menuClick(label)` in scope.
//
// With YOMI_TEST_CLOCK=1 the main process's timers and Date run on a clock a
// lane can move: advance(ms) is time passing — every timer due by then fires
// — and jump(ms) moves only the wall clock, as a machine waking from sleep
// does while its timers had stood still.

const Module = require('module');
const net = require('net');
const { performance } = require('perf_hooks');
const path = require('path');
const electron = require('electron');

const APP_DIR = process.env.YOMI_TEST_APP;
const STAGE = process.env.YOMI_TEST_STAGE ? JSON.parse(process.env.YOMI_TEST_STAGE) : null;

const rec = { dialogs: [], opened: [], focus: 0, dock: [], shortcuts: [], menu: [],
              tooltip: null, windows: [] };

// --- the clock -----------------------------------------------------------------

const real = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
let skew = 0;         // what advance() added: timers and the wall clock
let wall = 0;         // what jump() added: the wall clock only
const vnow = () => real.now() + skew;
const timers = new Set();

function arm(t) {
  real.clearTimeout(t.handle);
  t.handle = real.setTimeout(() => fire(t), Math.max(0, t.due - vnow()));
  if (!t.referenced && t.handle.unref) t.handle.unref();
}
function fire(t) {
  if (!timers.has(t)) return;
  if (t.every) { t.due += t.every; arm(t); } else timers.delete(t);
  t.fn(...t.args);
}
function schedule(fn, ms, args, every) {
  const t = { fn, args, due: vnow() + Math.max(0, ms || 0), every, referenced: true };
  timers.add(t);
  arm(t);
  // The surface Node's Timeout offers and the app's code uses.
  t.api = {
    unref() { t.referenced = false; if (t.handle.unref) t.handle.unref(); return t.api; },
    ref() { t.referenced = true; if (t.handle.ref) t.handle.ref(); return t.api; },
    hasRef: () => t.referenced,
    refresh() { t.due = vnow() + (t.every || Math.max(0, ms || 0)); arm(t); return t.api; },
    [Symbol.toPrimitive]: () => t.handle[Symbol.toPrimitive](),
  };
  t.api.__timer = t;
  return t.api;
}
function cancel(api) {
  const t = api && api.__timer;
  if (!t) { real.clearTimeout(api); return; }
  timers.delete(t);
  real.clearTimeout(t.handle);
}

const clock = {
  /** Time passes: the wall clock moves and every timer due by then fires. */
  advance(ms) {
    skew += ms;
    for (const t of [...timers].sort((a, b) => a.due - b.due)) arm(t);
  },
  /** The machine slept: the wall clock moved, the timers did not. */
  jump(ms) { wall += ms; },
  pending: () => timers.size,
};

if (process.env.YOMI_TEST_CLOCK === '1') {
  global.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, 0);
  global.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, Math.max(1, ms || 0));
  global.clearTimeout = cancel;
  global.clearInterval = cancel;
  Date.now = () => vnow() + wall;
  // Monotonic time moves with the timers, and not with the wall clock.
  const perf = performance.now.bind(performance);
  performance.now = () => perf() + skew;
}

// --- what the user would see -------------------------------------------------------

/** Menu items as labels, submenus flattened, for a lane to read. */
const labels = (menu) => menu.items.flatMap((i) =>
  (i.submenu ? labels(i.submenu) : i.type === 'separator' ? [] : [{
    label: i.label, enabled: i.enabled, click: typeof i.click === 'function' }]));

let lastMenu = null;
/** Click the tray menu's item labelled `label`, as the user would. */
function menuClick(label) {
  const find = (menu) => {
    for (const i of menu.items) {
      if (i.label === label) return i;
      const sub = i.submenu && find(i.submenu);
      if (sub) return sub;
    }
    return null;
  };
  const item = lastMenu && find(lastMenu);
  if (!item || !item.click) throw new Error(`no tray item "${label}"`);
  item.click();
}

class Tray {
  constructor(icon) { this.icon = icon; this.menu = null; }
  setToolTip(t) { rec.tooltip = t; }
  setContextMenu(m) { this.menu = m; rec.menu = labels(m); lastMenu = m; }
  setImage() {}
  setTitle(t) { rec.title = t; }
  destroy() {}
  on() { return this; }
}

class BrowserWindow extends electron.BrowserWindow {
  constructor(o = {}) {
    const panel = o.type === 'panel';
    const wanted = o.show !== false;
    const placed = !panel && STAGE
      ? { x: STAGE.x + 40 + rec.windows.length * 30, y: STAGE.y + 40 } : {};
    super({ ...o, ...placed, show: panel ? o.show : false });
    rec.windows.push({ title: o.title || null, panel });
    // Shown, but not brought forward: the app would take focus from whatever
    // the user is doing.
    if (!panel && wanted) this.showInactive();
  }
  focus() { rec.focus++; }
}

const overrides = {
  Tray,
  BrowserWindow,
  dialog: new Proxy(electron.dialog, {
    get(t, k) {
      if (k === 'showMessageBox') {
        return async (...a) => {
          const o = a.find((x) => x && typeof x === 'object' && 'message' in x) || {};
          rec.dialogs.push({ type: o.type, title: o.title, message: o.message,
                             detail: o.detail, buttons: o.buttons });
          // The last button is the one that does nothing: "Later", "OK".
          return { response: Math.max(0, (o.buttons || ['OK']).length - 1),
                   checkboxChecked: false };
        };
      }
      if (k === 'showErrorBox') {
        return (title, content) => rec.dialogs.push({ title, detail: content });
      }
      return t[k];
    },
  }),
  shell: new Proxy(electron.shell, {
    get(t, k) {
      if (k === 'openExternal') return async (url) => { rec.opened.push(url); };
      return t[k];
    },
  }),
  globalShortcut: new Proxy(electron.globalShortcut, {
    get(t, k) {
      if (k === 'register') return (accel) => { rec.shortcuts.push(accel); return true; };
      if (k === 'unregisterAll') return () => {};
      return t[k];
    },
  }),
  systemPreferences: new Proxy(electron.systemPreferences, {
    get(t, k) {
      if (k === 'isTrustedAccessibilityClient' && process.env.YOMI_TEST_AX === '0') {
        return () => false;
      }
      return t[k];
    },
  }),
};

// app.focus and app.dock: the app itself, so patched in place.
electron.app.focus = () => { rec.focus++; };
if (electron.app.dock) {
  const hide = electron.app.dock.hide.bind(electron.app.dock);
  electron.app.dock.show = async () => { rec.dock.push('show'); };
  electron.app.dock.hide = () => { rec.dock.push('hide'); hide(); };
}

const proxy = new Proxy(electron, {
  get: (t, k) => (k in overrides ? overrides[k] : t[k]),
});
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? proxy : load.call(this, request, ...rest);
};

// --- the control channel ----------------------------------------------------------

const AsyncFunction = (async () => {}).constructor;
try {
  const ctl = new net.Socket({ fd: 3, readable: true, writable: true });
  let buf = '';
  ctl.setEncoding('utf8');
  ctl.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const { id, code } = JSON.parse(line);
      new AsyncFunction('require', 'rec', 'clock', 'menuClick', code)(
        require, rec, clock, menuClick)
        .then((value) => ctl.write(JSON.stringify({ id, ok: true, value }) + '\n'))
        .catch((e) => ctl.write(
          JSON.stringify({ id, ok: false, error: String((e && e.stack) || e) }) + '\n'));
    }
  });
  ctl.on('error', () => {});
} catch { /* started without a control pipe: nothing to answer */ }

require(path.join(APP_DIR, 'main.js'));
