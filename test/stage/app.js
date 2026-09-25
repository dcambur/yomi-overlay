// The real app under test: started with a profile and user directory of its
// own, reached through the DevTools protocol, and — started through
// in-app.js — through its main process too.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bounded, waitFor, track, killTree } = require('./harness.js');

const ROOT = path.resolve(__dirname, '..', '..');
const mk = require(path.join(ROOT, 'test', 'fixtures', 'make-dictionary.js'));
const { build } = require(path.join(ROOT, 'app', 'main', 'index-builder.js'));

// On the stage page (horizontal.html), and in the dictionary a lane gives the app.
const STAGE_WORDS = [['猫', 'ねこ'], ['名前', 'なまえ'], ['吾輩', 'わがはい'], ['見当', 'けんとう'],
                     ['記憶', 'きおく'], ['人間', 'にんげん'], ['書生', 'しょせい']];

/** Chrome DevTools Protocol on one of the app's pages: the overlay by default. */
async function devtools(profile, page = '/renderer/index.html') {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor('the app to open DevTools', () =>
    fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await waitFor(`the page ${page}`, async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.split('?')[0].endsWith(page));
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await bounded(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
                3000, 'opening DevTools');
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  };
  const call = (method, params = {}) => bounded(new Promise((resolve, reject) => {
    seq++;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
  }), 5000, `DevTools ${method}`);
  return {
    eval: async (expression) => {
      const r = await call('Runtime.evaluate',
                           { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    /** A pointer event delivered to the page itself: the real cursor stays put. */
    mouse: (type, x, y, extra = {}) =>
      call('Input.dispatchMouseEvent', { type, x, y, ...extra }),
    /** Kill the page's renderer process. The socket goes with it. */
    crash: () => { call('Page.crash').catch(() => {}); },
    close: () => ws.close(),
  };
}

// The glyph layer as lines of screen-space boxes, the shape alignment() reads.
const LAYER = `(() => {
  const byLine = {};
  for (const s of document.querySelectorAll('.g')) {
    const r = s.getBoundingClientRect();
    (byLine[s.dataset.li] = byLine[s.dataset.li] || []).push({ ci: +s.dataset.ci,
      c: s.textContent, x: r.left + screenX, y: r.top + screenY, w: r.width, h: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  }
  return Object.values(byLine).map((cs) => {
    cs.sort((a, b) => a.ci - b.ci);
    return { text: cs.map((c) => c.c).join(''), chars: cs };
  });
})()`;

const POPUP = `(() => {
  const p = document.getElementById('popup');
  const b = p.querySelector('button.anki');
  const r = b && b.getBoundingClientRect();
  return { shown: getComputedStyle(p).display !== 'none', text: p.textContent,
           hits: document.querySelectorAll('.g.hit').length,
           mark: b && { state: b.dataset.state,
                        x: r.left + r.width / 2, y: r.top + r.height / 2 } };
})()`;
/**
 * The app, launched. Its own Electron profile (so its own single-instance
 * lock and DevTools port file) and its own YOMI_USER_DIR (config, index, log),
 * so it runs beside an installed Yomi Overlay without touching it.
 *
 *   root     the checkout to run (a fresh clone, for the first-run lane)
 *   dir      its user directory; a new temp one if omitted
 *   config   written as config.json, if given — none is a first run
 *   shim     start it through in-app.js, which records what it would show
 *   stage    the invisible display, where the shim opens its windows
 *   clock    the shim's movable clock (YOMI_TEST_CLOCK)
 */
async function launchApp(o = {}) {
  const root = o.root || ROOT;
  const dir = o.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-app-'));
  const profile = path.join(dir, 'electron');
  if (o.config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(o.config));
  const env = { ...process.env, YOMI_USER_DIR: dir, ...(o.env || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  if (o.shim) {
    env.YOMI_TEST_APP = path.join(root, 'app');
    if (o.stage) env.YOMI_TEST_STAGE = JSON.stringify(o.stage);
    if (o.clock) env.YOMI_TEST_CLOCK = '1';
  }
  const entry = o.shim ? path.join(__dirname, 'in-app.js') : path.join(root, 'app');
  const out = [];
  const argv = [entry, `--user-data-dir=${profile}`, '--remote-debugging-port=0'];
  // So a lane can collect garbage before it weighs what the main process holds.
  if (o.shim) argv.push('--js-flags=--expose-gc');
  const stdio = ['ignore', 'pipe', 'pipe', o.shim ? 'pipe' : 'ignore'];
  const child = track(spawn(process.execPath, argv, { env, stdio }));
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => {
      out.push(d);
      if (process.env.VERBOSE) process.stdout.write(d.replace(/^/gm, '    [app] '));
    });
  }
  const pending = new Map();
  let seq = 0;
  if (o.shim) {
    let buf = '';
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        const p = pending.get(m.id);
        if (!p) continue;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
      }
    });
    child.stdio[3].on('error', () => {});
  }
  return {
    child, dir, profile,
    /** Everything the app printed so far. */
    output: () => out.join(''),
    /** The app's own log file, as the user would read it. */
    log: () => {
      try { return fs.readFileSync(path.join(dir, 'yomi-overlay.log'), 'utf8'); }
      catch { return ''; }
    },
    /** Run `code` in the app's main process (shim only); resolves its value. */
    eval: (code) => bounded(new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdio[3].write(JSON.stringify({ id, code }) + '\n');
    }), 5000, 'an eval in the app'),
    /** DevTools on the overlay page, or on `page` (e.g. '/settings/settings.html'). */
    page: (page) => devtools(profile, page),
    /** Quit the way the user's SIGTERM would, and wait for it; SIGKILL at 5 s. */
    async quit() {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await bounded(exited, 5000, 'the app to quit').catch(() => killTree(child));
    },
  };
}

/**
 * The app over `target`, a window on the stage, with a dictionary of the stage
 * page's words: what a lane that is not about the first run starts from.
 */
function appOnStage(target, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-app-'));
  fs.mkdirSync(path.join(dir, 'dicts'));
  mk.termDictionary(path.join(dir, 'dicts', 'stage.zip'),
                    { title: 'Stage', shape: 'jmdict', words: STAGE_WORDS });
  build(path.join(dir, 'dicts'), path.join(dir, 'index.db'));
  const config = { target: { bundle: 'com.github.Electron', app: null, windowId: target.id,
                             label: 'stage' }, interval: 0.3, ...(o.config || {}) };
  return launchApp({ ...o, dir, config });
}

/** The pid of the app's capture child, the watch loop; null if there is none. */
function watchPid(app) {
  try {
    const args = ['-P', String(app.child.pid), '-f', 'yomi --json --watch'];
    const out = execFileSync('pgrep', args, { encoding: 'utf8' });
    return Number(out.split('\n')[0]) || null;
  } catch { return null; }
}

/**
 * Shift over `word` on the overlay page, as a reader would, and the popup it
 * opens; `cdp` is the overlay page. Pressed again each second, as a reader
 * would: a layer rebuilt while the lookup was in flight drops its answer on
 * purpose, and right after a (re)start the helper re-reads the page a few
 * times (engine and orientation probes, votes).
 */
async function lookUp(cdp, word) {
  return waitFor(`the popup for ${word}`, async () => {
    const layer = await cdp.eval(LAYER);
    const line = layer.find((l) => l.text.includes(word));
    if (!line) return false;
    const c = line.chars[line.text.indexOf(word)];
    await cdp.mouse('mouseMoved', 1, 1);
    await cdp.mouse('mouseMoved', c.cx, c.cy, { modifiers: 8 });
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      const v = await cdp.eval(POPUP);
      if (v.shown) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  });
}

const glyphCount = (cdp) => cdp.eval("document.querySelectorAll('.g').length");

module.exports = {
  devtools, launchApp, appOnStage, watchPid, lookUp, glyphCount, LAYER, POPUP, STAGE_WORDS,
};
