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

const { app } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { APP_DIR, BIN_DIR, OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));
const { build } = require(path.join(ROOT, 'app', 'main', 'index-builder.js'));
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const mk = require(path.join(FIXTURES, 'make-dictionary.js'));
const { ankiDouble } = require(path.join(FIXTURES, 'anki-double.js'));

const HELPERS = path.join(BIN_DIR, 'test');
const STAGE = path.join(ROOT, 'test', 'stage');
const { SUITE_LIMIT_MS, results, sleep, check, note, test, waitFor, track, lines } =
  require(path.join(STAGE, 'harness.js'));
const { capture, watch, listAll } = require(path.join(STAGE, 'yomi.js'));
const { openDisplay, stageWindow, raise, contentOrigin, serverRect, near } =
  require(path.join(STAGE, 'display.js'));
const { EXTRACT, EXTRACT_CHARS, alignment, assertAligned } =
  require(path.join(STAGE, 'truth.js'));
const { devtools, LAYER, POPUP } = require(path.join(STAGE, 'app.js'));

// Longer than the 31 bytes kCGWindowOwnerName keeps (ListCommand.swift).
const RIG_NAME = 'RigWithANameTheWindowServerTruncates.exe';
// What every Electron window reports — the stage's and the app under test's.
const ELECTRON_BUNDLE = 'com.github.Electron';

let D = null;

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

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
  const V = await stageWindow(path.join(STAGE, 'vertical.html'),
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

    await test('a crashed overlay page comes back with its glyph layer', async () => {
      const count = "document.querySelectorAll('.g').length";
      const before = await cdp.eval(count);
      cdp.crash();
      cdp.close();
      // The page is reloaded in a new renderer; the old target lingers a beat.
      await sleep(500);
      cdp = await waitFor('the reloaded page', async () => {
        try {
          const c = await devtools(profile);
          await c.eval('1');
          return c;
        } catch { return null; }
      });
      // A static page: only heartbeats arrive, and they carry no lines — the
      // layer can only come back if main replays what it last sent.
      await waitFor('the layer to come back', async () =>
        (await cdp.eval(count)) === before, 5000);
    });

    await test('the overlay leaves when the target does', async () => {
      // A popup open first, so its closing is something this test can see.
      const layer = await cdp.eval(LAYER);
      const line = layer.find((l) => l.text.includes('吾輩は猫である'));
      check(line, 'the line with 猫 is not in the layer');
      const cat = line.chars[line.text.indexOf('猫')];
      await cdp.mouse('mouseMoved', 1, 1);
      await cdp.mouse('mouseMoved', cat.cx, cat.cy, { modifiers: 8 });
      await waitFor('the popup', async () => (await cdp.eval(POPUP)).shown);
      const gone = Date.now();
      A.win.hide();
      await waitFor('the popup to close', async () => !(await cdp.eval(POPUP)).shown);
      await waitFor('the panel to hide',
                    () => cdp.eval("document.visibilityState === 'hidden'"));
      note(`hidden ${Date.now() - gone}ms after the target was`);
      A.win.showInactive();
    });

    await test('a page that crashes twice in 10 s is given up, off the screen', async () => {
      // The overlay panel of the app under test: the only display-sized window.
      const panel = () => listAll().find((w) => w.bundle === ELECTRON_BUNDLE
        && w.width === D.width && w.height === D.height);
      await waitFor('the panel back on screen', () => (panel() || {}).onScreen);
      cdp.crash();
      cdp.close();
      cdp = null;
      await waitFor('the panel to leave the screen', () => {
        const p = panel();
        return p && !p.onScreen;
      });
      const log = fs.readFileSync(path.join(dir, 'yomi-overlay.log'), 'utf8');
      check(/gone again .*not reloading/.test(log), 'the app did not say it gave up');
      // Stays off: payloads keep arriving, and each used to re-show the panel.
      await sleep(1500);
      check(!panel().onScreen, 'the dead panel came back over the target');
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

    await test('the app logged into its own directory, each line once', async () => {
      const log = fs.readFileSync(path.join(dir, 'yomi-overlay.log'), 'utf8').split('\n');
      const launches = log.filter((l) => l.includes('--- launch, argv=')).length;
      check(launches === 1, `the launch line is in the log ${launches} times`);
    });
  } finally {
    if (cdp) cdp.close();   // null once the page has been given up on
    if (child && child.exitCode === null) child.kill('SIGKILL');
    anki.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- run -----------------------------------------------------------------------

/**
 * A bin/yomi never run before recognises nothing until Vision has compiled its
 * model for the new binary: 29-64 s, once (measured 2026-09-24), where a read
 * is otherwise 1-3 s. test/run.sh asks for this when the helper is newer than
 * its last warm-up, so that minute is spent once, announced, and not on a test.
 */
async function warmUp(A) {
  console.log('warming up a freshly built bin/yomi — Vision compiles its model '
              + 'once per binary (measured 29-64 s)');
  const t = Date.now();
  const { payload, err } = await capture(['--window', String(A.id)], 120000);
  if (!payload) throw new Error(`the helper never answered: ${err.trim().slice(-200)}`);
  console.log(`warm after ${((Date.now() - t) / 1000).toFixed(0)}s`);
}

app.whenReady().then(async () => {
  let t0 = Date.now();
  try {
    D = await openDisplay();
    console.log(`display ${D.id} at ${D.x},${D.y} ${D.width}x${D.height}, invisible`);
    const A = await stageWindow(path.join(STAGE, 'horizontal.html'),
                                { x: 120, y: 90, width: 1000, height: 700 });
    if (process.env.YOMI_WARM) await warmUp(A);
    t0 = Date.now();
    setTimeout(() => {
      console.log(`FAIL  the suite ran past ${SUITE_LIMIT_MS / 1000}s — stopped`);
      app.exit(1);                  // process 'exit' kills every child
    }, SUITE_LIMIT_MS);
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
