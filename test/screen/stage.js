// The screen suite: the real window server, the real capture helper and the
// real app, on a display nobody can see.
//
// It replaces test/main.js and the verify*.py suites. Those put two or three
// windows on the user's own screen — one of them fullscreen, which took over
// the Space in front of them — loaded kakuyomu.jp over the network, and ran
// the real app against data/config.json, restoring it afterwards if nothing
// crashed first. Here every window lives on bin/test/virtual-display's screen:
// the window server composites it and ScreenCaptureKit captures it, but no
// monitor shows it, and it meets the real display at one corner only. This
// process is an accessory app — no Dock tile, no menu bar, never frontmost —
// so a run does not take focus from whatever the user is doing.
//
// What is asserted is what the old suites asserted, against the same ground
// truth: the live DOM for where glyphs are, the window server for which window
// is the target. Waits poll for their condition instead of sleeping.
//
//   test/run.sh screen      needs Screen Recording for the terminal, and the
//                           overlay not running (two capture sessions stall)

const { app, BrowserWindow, screen } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { APP_DIR, BIN_DIR, OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));
const { build } = require(path.join(ROOT, 'app', 'main', 'index-builder.js'));
const FIXTURES = path.join(ROOT, 'test', 'unit', 'fixtures');
const mk = require(path.join(FIXTURES, 'make-dictionary.js'));
const { ankiDouble } = require(path.join(FIXTURES, 'anki-double.js'));

const HELPERS = path.join(BIN_DIR, 'test');
// Longer than the 31 bytes kCGWindowOwnerName keeps (ListCommand.swift).
const RIG_NAME = 'RigWithANameTheWindowServerTruncates.exe';
// What every Electron window reports — the stage's and the app under test's.
const ELECTRON_BUNDLE = 'com.github.Electron';

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

// --- harness ----------------------------------------------------------------

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, why) => { if (!cond) throw new Error(why); };
const note = (s) => console.log('        ' + s);

async function test(name, fn) {
  const t0 = Date.now();
  let why = null;
  try { await fn(); } catch (e) { why = e.message; }
  const ms = Date.now() - t0;
  results.push({ ok: !why, name, ms });
  console.log(`${why ? 'FAIL' : 'ok  '}  ${name} (${(ms / 1000).toFixed(1)}s)`
              + (why ? `\n        ${why}` : ''));
}

/** Poll until `probe` answers something truthy, and return it. */
async function waitFor(what, probe, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(50);
  }
}

// Everything spawned dies with the suite, however it ends.
const children = new Set();
function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });

/** Call `onLine` with each line a child prints. */
function lines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (l.trim()) onLine(l);
      i = buf.indexOf('\n');
    }
  });
}

/** One capture: the first payload `yomi --json` prints, or null. */
function capture(args, timeout = 30000) {
  return new Promise((resolve) => {
    const child = track(spawn(OCR_BIN, ['--json', ...args]));
    let payload = null;
    let err = '';
    lines(child.stdout, (l) => { payload = payload || JSON.parse(l); });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', () => { clearTimeout(timer); resolve({ payload, err }); });
  });
}

/** A long-running watch session, as the app runs it. */
function watch(args) {
  const child = track(spawn(OCR_BIN, ['--json', '--watch', '--interval', '0.3', ...args]));
  const seen = [];
  lines(child.stdout, (l) => seen.push({ at: Date.now(), m: JSON.parse(l) }));
  child.stderr.resume();
  return {
    /** The first message at or after `since` that `pred` accepts. */
    next: (what, pred, since = 0, timeout = 10000) =>
      waitFor(what, () => seen.find((s) => s.at >= since && pred(s.m)), timeout),
    stop: () => child.kill(),
  };
}

const listAll = () => JSON.parse(execFileSync(OCR_BIN, ['--list-all'], { encoding: 'utf8' }));

// --- the invisible display and the windows on it ----------------------------

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
  return { ...d, close: () => child.stdin.end() };
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

// --- ground truth ------------------------------------------------------------

// Single-line, directly texted, fully visible Japanese elements. Measured as
// TEXT, not element boxes: a padded block's rect can sit far from its glyphs.
const EXTRACT = `(() => {
  const re = /[\\u3040-\\u30ff\\u4e00-\\u9fff]{3,}/;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const t = Array.from(el.childNodes).filter(n => n.nodeType === 3)
      .map(n => n.textContent).join('').replace(/\\s+/g, '');
    if (!re.test(t)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (r.width < 20 || r.height < 10 || fs < 11) continue;
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
    if (r.height > fs * 1.9) continue;            // wrapped: no single anchor
    out.push({ text: t.slice(0, 24), x: Math.round(r.x), y: Math.round(r.y),
               h: Math.round(r.height) });
  }
  return out;
})()`;

// Every Japanese character's own rect: in vertical text a paragraph is one
// tall column, so only per-character truth locates anything.
const EXTRACT_CHARS = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode()) && out.length < 400) {
    const t = n.textContent;
    for (let i = 0; i < t.length; i++) {
      if (!/[\\u3040-\\u30ff\\u4e00-\\u9fff]/.test(t[i])) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      if (b.width < 4 || b.height < 4) continue;
      out.push({ c: t[i], x: Math.round(b.x), y: Math.round(b.y),
                 w: Math.round(b.width), h: Math.round(b.height) });
    }
  }
  return out;
})()`;

const squash = (s) => s.replace(/\s+/g, '');

/**
 * How well recognised glyphs sit on the page's real text. `read` is lines of
 * glyph boxes relative to `at`; `probes` are DOM rects relative to `org`.
 * Asserted against the CLOSEST occurrence of each probe's text, so a
 * systematic shift still fails while a repeated nav label cannot fake one.
 */
function alignment(read, at, probes, org) {
  const needle = (p) => squash(p.text).slice(0, 6);
  // A probe whose text recurs cannot be pinned to one position.
  const unique = probes.filter((p) =>
    probes.filter((q) => squash(q.text).includes(needle(p))).length === 1);
  let matched = 0, aligned = 0, gross = 0, worst = '';
  for (const p of unique) {
    if (squash(p.text).length < 3) continue;
    let hit = null, best = Infinity;
    for (const ln of read) {
      // Indexed over the glyphs themselves: a line's text can carry spaces
      // (Vision puts them between the items of a nav bar) that no glyph has.
      const glyphs = ln.chars.filter((g) => g.c.trim());
      const i = glyphs.map((g) => g.c).join('').indexOf(needle(p));
      if (i < 0) continue;
      const c = glyphs[i];
      const d = Math.abs(at.x + c.x - (org.sx + p.x)) + Math.abs(at.y + c.y - (org.sy + p.y));
      if (d < best) { best = d; hit = c; }
    }
    if (!hit) continue;
    matched++;
    const dx = Math.round(at.x + hit.x - (org.sx + p.x));
    const dy = Math.round(at.y + hit.y - (org.sy + p.y));
    // The DOM rect's top is the line box; the glyph sits inside its leading.
    if (Math.abs(dx) <= 12 && Math.abs(dy) <= Math.max(10, p.h * 0.45)) aligned++;
    else if (Math.abs(dx) > 30 || Math.abs(dy) > 30) {
      gross++;
      worst = `'${p.text}' off by (${dx},${dy})`;
    }
  }
  return { probes: unique.length, matched, aligned, gross, worst };
}

function assertAligned(a, label) {
  note(`${label}: ${a.aligned}/${a.matched} probes on their glyphs, ${a.gross} gross`
       + (a.worst ? ` — worst ${a.worst}` : ''));
  check(a.matched >= 8, `only ${a.matched} of ${a.probes} probes were recognised at all`);
  check(a.aligned / a.matched >= 0.7, `${a.aligned}/${a.matched} aligned, need 70%`);
  check(a.gross === 0, `${a.gross} glyphs more than 30px off (${a.worst})`);
}

// --- capture: selection, visibility and geometry ------------------------------

async function captureScenarios(A, B) {
  const aRect = () => A.win.getBounds();

  await test('capture follows the frontmost of two windows of one app', async () => {
    for (const w of [A, B, A]) {
      await raise(w);
      const { payload } = await capture(['--bundle', ELECTRON_BUNDLE]);
      check(payload, `nothing captured with window ${w.id} in front`);
      check(near(payload.window, w.win.getBounds()),
            `captured ${JSON.stringify(payload.window)}, front is ${w.id}`);
    }
  });

  await test('a window parked off every display is never the target', async () => {
    // Where the window server parks another Space's windows. Parked beside
    // the invisible display, so the sliver it keeps on screen is on that one.
    B.win.setBounds({ x: D.x + D.width + 400, y: D.y + 122, width: 1000, height: 700 });
    await raise(B);
    const { payload } = await capture(['--bundle', ELECTRON_BUNDLE]);
    check(payload && near(payload.window, aRect()),
          `captured ${JSON.stringify(payload && payload.window)}, want window ${A.id}`);
  });

  await test('a window over half the target is reported as a cover', async () => {
    const a = aRect();
    B.win.setBounds({ x: a.x + a.width / 2, y: a.y, width: a.width / 2, height: a.height });
    await raise(B);
    const { payload } = await capture(['--window', String(A.id)]);
    check(payload, 'nothing captured');
    const c = payload.covers || [];
    note(`covers ${JSON.stringify(c)}`);
    check(c.length === 1, `${c.length} cover regions, want 1`);
    check(Math.abs(c[0].x - a.width / 2) <= a.width / 20 &&
          Math.abs(c[0].w - a.width / 2) <= a.width / 20,
          'the cover is not the right half');
  });

  await test('a buried target goes idle at once, and comes back', async () => {
    const a = aRect();
    const w = watch(['--window', String(A.id)]);
    try {
      B.win.setBounds({ x: D.x + D.width + 400, y: D.y + 122, width: 1000, height: 700 });
      await w.next('a first payload', (m) => m.frame);
      B.win.setBounds(a);
      await raise(B);
      const buried = Date.now();
      const idle = await w.next('the idle marker', (m) => m.idle, buried);
      note(`idle ${idle.at - buried}ms after the target was covered (measured 150ms, §3)`);
      B.win.setBounds({ x: D.x + D.width + 400, y: D.y + 122, width: 1000, height: 700 });
      await w.next('capture to resume', (m) => m.frame, Date.now());
    } finally { w.stop(); }
  });

  await test('glyph boxes land on the real text', async () => {
    await raise(A);
    const { payload } = await capture(['--window', String(A.id)]);
    check(payload, 'nothing captured');
    const probes = await A.win.webContents.executeJavaScript(EXTRACT);
    assertAligned(alignment(payload.lines, payload.frame, probes, await contentOrigin(A)),
                  'top of page');
  });

  await test('and still do after the page scrolls', async () => {
    await A.win.webContents.executeJavaScript('window.scrollTo(0, 420)');
    const { payload } = await capture(['--window', String(A.id)]);
    check(payload, 'nothing captured');
    const probes = await A.win.webContents.executeJavaScript(EXTRACT);
    assertAligned(alignment(payload.lines, payload.frame, probes, await contentOrigin(A)),
                  'scrolled 420px');
    await A.win.webContents.executeJavaScript('window.scrollTo(0, 0)');
  });

  await test('a fullscreen target is captured with its true frame', async () => {
    const entered = new Promise((r) => A.win.once('enter-full-screen', r));
    A.win.setFullScreen(true);
    await entered;
    // The Space slides in; capture mid-slide reads a transient x.
    await waitFor('the fullscreen Space to settle', () => {
      const s = serverRect(A);
      return s && s.x === D.x && s.width === D.width;
    });
    const { payload } = await capture(['--window', String(A.id)]);
    check(payload, 'nothing captured');
    check(near(payload.frame, D) && payload.frame.width === D.width,
          `frame ${JSON.stringify(payload.frame)}, display at ${D.x},${D.y}`);
    const probes = await A.win.webContents.executeJavaScript(EXTRACT);
    assertAligned(alignment(payload.lines, payload.frame, probes, await contentOrigin(A)),
                  'fullscreen');
    const left = new Promise((r) => A.win.once('leave-full-screen', r));
    A.win.setFullScreen(false);
    await left;
    await waitFor('the window to be back', () => {
      const s = serverRect(A);
      return s && s.width < D.width;
    });
  });
}

async function verticalScenario() {
  const V = await stageWindow(path.join(__dirname, 'vertical.html'),
                              { x: 260, y: 110, width: 900, height: 680 });
  try {
    await test('tategaki is read in columns and lands on its glyphs', async () => {
      // No --vertical: the app never passes it, so orientation detection is
      // part of what is under test.
      const { payload } = await capture(['--window', String(V.id)]);
      check(payload, 'nothing captured');
      const truth = await V.win.webContents.executeJavaScript(EXTRACT_CHARS);
      const org = await contentOrigin(V);
      const f = payload.frame;
      const got = payload.lines.flatMap((l) =>
        l.chars.map((c) => ({ ...c, x: f.x + c.x, y: f.y + c.y })));
      let present = 0, placed = 0;
      for (const t of truth) {
        const x = org.sx + t.x, y = org.sy + t.y;
        const same = got.filter((g) => g.c === t.c);
        if (!same.length) continue;
        present++;
        const g = same.reduce((a, b) =>
          (Math.abs(a.x - x) + Math.abs(a.y - y) <= Math.abs(b.x - x) + Math.abs(b.y - y)
            ? a : b));
        const tol = Math.max(12, t.w * 0.7, t.h * 0.7);
        if (Math.abs(g.x - x) <= tol && Math.abs(g.y - y) <= tol) placed++;
      }
      const firsts = payload.lines.filter((l) => l.chars.length).map((l) => l.chars[0]);
      const rtl = firsts.slice(1).filter((c, i) => c.x < firsts[i].x).length;
      note(`coverage ${present}/${truth.length}, placement ${placed}/${truth.length}, `
           + `columns right-to-left ${rtl}/${firsts.length - 1}`);
      // The gates INTEGRATION.md set for the DOM-truth suite.
      check(present / truth.length >= 0.9, 'coverage under 90%');
      check(placed / truth.length >= 0.7, 'placement under 70%');
      check(rtl >= (firsts.length - 1) * 0.8, 'columns are not read right to left');
    });
  } finally { V.win.close(); }
}

async function pickerScenario() {
  await test('the picker offers an app with no bundle id, and follows it', async () => {
    const rig = track(spawn(path.join(HELPERS, RIG_NAME),
                            [String(D.x + 300), String(D.y + 150)]));
    try {
      const [bundle, name] = await new Promise((resolve) =>
        lines(rig.stdout, (l) => resolve(l.split('\t'))));
      check(!bundle && name === RIG_NAME,
            `the rig is not the shape this test needs (${bundle}, ${name})`);
      const hit = await waitFor('--list-all to offer the rig',
                                () => listAll().find((w) => w.app === name));
      check(hit.bundle === '', `listed with bundle ${JSON.stringify(hit.bundle)}`);
      const out = execFileSync(OCR_BIN, ['--app', name, '--list'], { encoding: 'utf8' });
      check(out.includes(`id=${hit.id} `), `--app ${name} --list resolved: ${out.trim()}`);
    } finally { rig.kill(); }
  });
}

// --- the app, end to end ---------------------------------------------------------

// On the stage page, and in the dictionary the app is given.
const WORDS = [['猫', 'ねこ'], ['名前', 'なまえ'], ['吾輩', 'わがはい'], ['見当', 'けんとう'],
               ['記憶', 'きおく'], ['人間', 'にんげん'], ['書生', 'しょせい']];

/** Chrome DevTools Protocol on the app's overlay page. */
async function devtools(profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor('the app to open DevTools', () =>
    fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await waitFor('the overlay page', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.endsWith('/renderer/index.html'));
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    seq++;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
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

async function appScenario(A, B) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-e2e-'));
  const profile = path.join(dir, 'electron');
  const anki = ankiDouble();
  await new Promise((r) => anki.server.listen(0, '127.0.0.1', r));
  let child = null, cdp = null;
  try {
    fs.mkdirSync(path.join(dir, 'dicts'));
    mk.termDictionary(path.join(dir, 'dicts', 'stage.zip'),
                      { title: 'Stage', shape: 'jmdict', words: WORDS });
    build(path.join(dir, 'dicts'), path.join(dir, 'index.db'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      target: { bundle: ELECTRON_BUNDLE, app: null, windowId: A.id, label: 'stage' },
      interval: 0.3,
      anki: { enabled: true, deck: 'Mining', tags: ['yomi-overlay'], picture: true,
              url: `http://127.0.0.1:${anki.server.address().port}`, key: null },
    }));
    B.win.setBounds({ x: D.x + D.width + 400, y: D.y + 122, width: 1000, height: 700 });
    await raise(A);

    const env = { ...process.env, YOMI_USER_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const launched = Date.now();
    // Its own profile: its own single-instance lock and DevTools port file,
    // so the suite runs beside an installed Yomi Overlay without touching it.
    child = track(spawn(process.execPath,
                        [APP_DIR, `--user-data-dir=${profile}`, '--remote-debugging-port=0'],
                        { env, stdio: process.env.VERBOSE ? 'inherit' : 'ignore' }));
    cdp = await devtools(profile);

    await test('the app builds a glyph layer over the target', async () => {
      await waitFor('glyph spans', () => cdp.eval("document.querySelectorAll('.g').length"),
                    20000);
      note(`first layer ${Date.now() - launched}ms after launch`);
      const layer = await cdp.eval(LAYER);
      const probes = await A.win.webContents.executeJavaScript(EXTRACT);
      assertAligned(alignment(layer, { x: 0, y: 0 }, probes, await contentOrigin(A)),
                    'overlay spans');
    });

    await test('Shift over a word opens its entry', async () => {
      const layer = await cdp.eval(LAYER);
      const line = layer.find((l) => l.text.includes('吾輩は猫である'));
      check(line, 'the line with 猫 is not in the layer');
      const cat = line.chars[line.text.indexOf('猫')];
      await cdp.mouse('mouseMoved', cat.cx, cat.cy, { modifiers: 8 });
      const p = await waitFor('the popup', async () => {
        const v = await cdp.eval(POPUP);
        return v.shown && v;
      });
      const gloss = `meaning ${WORDS.findIndex((w) => w[0] === '猫')}`;
      check(p.text.includes('ねこ') && p.text.includes(gloss),
            `popup reads: ${p.text.slice(0, 120)}`);
      check(p.hits === 1, `${p.hits} glyphs highlighted, want 1`);
    });

    await test('the card mark adds a Lapis note with sentence and picture', async () => {
      const mark = await waitFor('the deck check', async () => {
        const v = await cdp.eval(POPUP);
        return v.mark && v.mark.state === 'absent' && v.mark;
      });
      await cdp.mouse('mouseMoved', mark.x, mark.y);
      await cdp.mouse('mousePressed', mark.x, mark.y, { button: 'left', clickCount: 1 });
      await cdp.mouse('mouseReleased', mark.x, mark.y, { button: 'left', clickCount: 1 });
      await waitFor('the note to be added', async () => {
        const v = await cdp.eval(POPUP);
        return v.mark && v.mark.state === 'present';
      });
      const [n] = [...anki.notes.values()];
      check(n && n.fields.Expression === '猫', 'no note for 猫 reached Anki');
      check(/<b>猫<\/b>/.test(n.fields.Sentence) && n.fields.Sentence.includes('吾輩は'),
            `sentence: ${n.fields.Sentence}`);
      check(n.picture.length === 1 && n.picture[0].bytes.subarray(1, 4).toString() === 'PNG',
            'the picture is not a PNG');
    });

    await test('the overlay leaves when the target does', async () => {
      const gone = Date.now();
      A.win.hide();
      await waitFor('the popup to close', async () => !(await cdp.eval(POPUP)).shown);
      await waitFor('the panel to hide',
                    () => cdp.eval("document.visibilityState === 'hidden'"));
      note(`hidden ${Date.now() - gone}ms after the target was`);
      A.win.showInactive();
    });

    await test('quitting takes both capture children with it', async () => {
      // By binary: Electron's own helper processes are children too.
      const kids = execFileSync('pgrep', ['-P', String(child.pid), '-f', OCR_BIN],
                                { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
      check(kids.length === 2, `${kids.length} capture children before quitting, want 2`);
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const late = sleep(5000).then(() => { throw new Error('the app did not exit'); });
      await Promise.race([exited, late]);
      await waitFor('the children to exit', () => kids.every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }), 3000);
    });
  } finally {
    if (cdp) cdp.close();
    if (child && child.exitCode === null) child.kill('SIGKILL');
    anki.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- run -----------------------------------------------------------------------

app.whenReady().then(async () => {
  const t0 = Date.now();
  try {
    D = await openDisplay();
    console.log(`display ${D.id} at ${D.x},${D.y} ${D.width}x${D.height}, invisible`);
    const A = await stageWindow(path.join(__dirname, 'horizontal.html'),
                                { x: 120, y: 90, width: 1000, height: 700 });
    const B = await stageWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="margin:0;background:#eee;font:26px Hiragino Kaku Gothic ProN">'
      + '<p style="margin:60px">囮のウィンドウです</p><p style="margin:60px">偽物の内容注意</p>'),
                                { x: 180, y: 140, width: 1000, height: 700 });
    await captureScenarios(A, B);
    await verticalScenario();
    await pickerScenario();
    await appScenario(A, B);
  } catch (e) {
    results.push({ ok: false, name: 'setup', ms: 0 });
    console.log(`FAIL  setup\n        ${e.stack || e.message}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in `
              + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (D) D.close();
  app.exit(failed ? 1 : 0);
});
