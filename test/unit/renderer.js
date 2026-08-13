// Characterization tests for the renderer, in a real hidden Electron window.
//
// Why this exists: the renderer's rebuild gate is the subtlest logic in the
// project (ARCHITECTURE section 5) and has never had a test. It currently
// lives inline in app/renderer/index.html, so it cannot be imported — which
// means tests written AFTER the step-6 extraction could not have guarded the
// extraction itself.
//
// So this drives index.html as a BLACK BOX, exactly the way the real main
// process does: the real preload, the real IPC channel names, real payloads
// captured from the ground-truth corpus. Record the behaviour now, extract in
// step 6, require these to still pass. Same discipline as test/golden.sh.
//
// Hidden window (`show: false`), so nothing appears on screen, and no
// permission of any kind is needed — this never captures anything.
//
// The load-bearing trick is markSpan()/spanSurvived(): a rebuild does
// `layer.innerHTML = ''`, so a property set on a live span vanishes if and
// only if the layer was rebuilt. That is what makes "kept" and "patched"
// distinguishable from "rebuilt" from the outside.
//
//   test/unit/run.sh          (or: electron test/unit/renderer.js)

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures');
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));

let win;
let lookupReply = null;          // what ipcMain.handle('lookup') returns
const ipcSeen = { interactive: [], tier2: [] };

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e.message]); }
}

const js = (expr) => win.webContents.executeJavaScript(expr);
const send = (ch, ...a) => win.webContents.send(ch, ...a);

/** Let the renderer's own async work settle before asserting. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

const glyphCount = () => js(`document.querySelectorAll('.g').length`);
const hitCount = () => js(`document.querySelectorAll('.g.hit').length`);
const popupShown = () => js(`getComputedStyle(document.getElementById('popup')).display !== 'none'`);
const layerTransform = () => js(`document.getElementById('layer').style.transform`);

/** Tag a live span. A rebuild wipes the layer, so the tag cannot survive one. */
const markSpan = () => js(
  `(() => { const s = document.querySelector('.g'); if (!s) return false;
            s.dataset.mark = 'x'; return true; })()`);
const spanSurvived = () => js(
  `!!document.querySelector('.g[data-mark="x"]')`);
const markedText = () => js(
  `(document.querySelector('.g[data-mark="x"]') || {}).textContent || null`);

// ---- payload shaping -------------------------------------------------------

/** Same page, one line's text altered — stays above the 85% similarity gate. */
function nudged(p, n = 1) {
  const q = JSON.parse(JSON.stringify(p));
  for (let i = 0; i < n && i < q.lines.length; i++) q.lines[i].text += '　';
  return q;
}

/** Same text, every glyph shifted — the "resize / scroll" case. */
function moved(p, dx = 40) {
  const q = JSON.parse(JSON.stringify(p));
  for (const l of q.lines) for (const c of l.chars) c.x += dx;
  return q;
}

/** A voted refinement: identical structure, one character corrected. */
function voted(p, vote = 2) {
  const q = JSON.parse(JSON.stringify(p));
  q.vote = vote;
  const c = q.lines[0].chars[0];
  c.c = c.c === '零' ? '一' : '零';
  q.lines[0].text = q.lines[0].chars.map(x => x.c).join('');
  for (const l of q.lines) for (const x of l.chars) x.f = 0.67;
  return q;
}

async function run() {
  const A = load('page-a.json');
  const B = load('page-b.json');

  await test('first payload builds the glyph layer', async () => {
    send('capture', A);
    await settle();
    const n = await glyphCount();
    assert.strictEqual(n, A.lines.reduce((s, l) => s + l.chars.length, 0),
      `expected one span per glyph, got ${n}`);
  });

  await test('identical payload does not rebuild', async () => {
    assert.ok(await markSpan(), 'no span to mark');
    send('capture', A);
    await settle();
    assert.ok(await spanSurvived(), 'layer was rebuilt on an identical payload');
  });

  await test('a >85% similar payload is refused (spans kept)', async () => {
    send('capture', nudged(A));
    await settle();
    assert.ok(await spanSurvived(), 'layer rebuilt on a near-identical payload');
  });

  await test('three consecutive refusals force a rebuild (ARCHITECTURE 5)', async () => {
    // Two more refusals: the streak is bounded at three, so the layer must
    // stop refusing and adopt the new content.
    send('capture', nudged(A, 1)); await settle();
    send('capture', nudged(A, 1)); await settle();
    assert.ok(!(await spanSurvived()),
      'layer never rebuilt — the bounded-refusal escape is gone');
  });

  await test('a page turn rebuilds', async () => {
    send('capture', A); await settle();
    assert.ok(await markSpan());
    send('capture', B); await settle();
    assert.ok(!(await spanSurvived()), 'page turn did not rebuild');
    assert.strictEqual(await glyphCount(),
      B.lines.reduce((s, l) => s + l.chars.length, 0));
  });

  await test('same text at moved coordinates rebuilds', async () => {
    send('capture', A); await settle();
    assert.ok(await markSpan());
    send('capture', moved(A)); await settle();
    assert.ok(!(await spanSurvived()),
      'a pure re-layout was treated as unchanged — spans would stay welded');
  });

  await test('a voted payload is patched in place, not rebuilt', async () => {
    send('capture', A); await settle();
    assert.ok(await markSpan());
    const before = await markedText();
    send('capture', voted(A)); await settle();
    assert.ok(await spanSurvived(),
      'voting rebuilt the layer instead of correcting in place');
    assert.notStrictEqual(await markedText(), before,
      'voted correction did not reach the DOM');
  });

  await test('offset places the layer against the panel position', async () => {
    send('offset', { fx: 300, fy: 200 });
    await settle();
    const t = await layerTransform();
    assert.match(t, /translate\(/, `layer not transformed: ${t}`);
  });

  await test('reset clears the layer', async () => {
    send('capture', A); await settle();
    send('reset'); await settle();
    assert.strictEqual(await glyphCount(), 0, 'reset left spans behind');
  });

  await test('dismiss hides the popup', async () => {
    send('dismiss'); await settle();
    assert.strictEqual(await popupShown(), false);
  });

  await test('a lookup inside a covered region is refused', async () => {
    send('capture', A); await settle();
    send('offset', { fx: 0, fy: 0 }); await settle();
    // Cover the whole frame, then trigger at a glyph.
    send('covers', [{ x: 0, y: 0, w: 10000, h: 10000 }]);
    await settle();
    lookupReply = { surface: 'x', matchLength: 1, groups: [], entries: [] };
    const c = A.lines[0].chars[0];
    send('trigger', { type: 'click', x: c.x + c.w / 2, y: c.y + c.h / 2 });
    await settle(120);
    assert.strictEqual(await hitCount(), 0,
      'a glyph behind another window was still looked up');
    send('covers', []); await settle();
  });

  const failed = results.filter(r => !r[0]);
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${err ? '\n        ' + err : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  ipcMain.handle('lookup', () => lookupReply);
  ipcMain.on('set-interactive', (_e, v) => ipcSeen.interactive.push(v));
  ipcMain.on('tier2', (_e, r) => ipcSeen.tier2.push(r));

  win = new BrowserWindow({
    show: false, width: 1440, height: 900,
    webPreferences: {
      // The REAL preload and the real isolation settings: the harness must
      // exercise the same trust boundary the app does, or it proves nothing.
      preload: path.join(ROOT, 'app', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', ({ message }) => {
    if (process.env.VERBOSE) console.log('    [renderer]', message);
  });
  await win.loadFile(path.join(ROOT, 'app', 'renderer', 'index.html'));
  await settle(150);
  await run();
});
