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
const ipcSeen = { interactive: [], tier2: [], ankiFind: [], ankiAdd: [], ankiRemove: [] };
// What main/anki.js answers: nothing in the deck yet, then note 42 once added.
let ankiIds = [];

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e.message]); }
}

const js = (expr) => win.webContents.executeJavaScript(expr);
const send = (ch, ...a) => win.webContents.send(ch, ...a);

/** Let the renderer's own async work settle before asserting. */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

const glyphCount = () => js('document.querySelectorAll(\'.g\').length');
const hitCount = () => js('document.querySelectorAll(\'.g.hit\').length');
const popupShown = () =>
  js("getComputedStyle(document.getElementById('popup')).display !== 'none'");
const layerTransform = () => js('document.getElementById(\'layer\').style.transform');

/** Tag a live span. A rebuild wipes the layer, so the tag cannot survive one. */
const markSpan = () => js(
  `(() => { const s = document.querySelector('.g'); if (!s) return false;
            s.dataset.mark = 'x'; return true; })()`);
const spanSurvived = () => js(
  '!!document.querySelector(\'.g[data-mark="x"]\')');
const markedText = () => js(
  '(document.querySelector(\'.g[data-mark="x"]\') || {}).textContent || null');

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

/** One line's glyphs displaced: how a re-read of an unchanged page comes back
 *  (measured 19–21px on one line under an animated background, 2026-09-10). */
function jittered(p, li = 0, d = 20) {
  const q = JSON.parse(JSON.stringify(p));
  for (const c of q.lines[li].chars) { c.x += d; c.y += d; }
  return q;
}

/** Every line with one character misread: the same page, and by exact line
 *  match a different one. */
function noisy(p) {
  const q = JSON.parse(JSON.stringify(p));
  for (const l of q.lines) {
    if (!l.chars.length) continue;
    const c = l.chars[l.chars.length >> 1];
    c.c = c.c === '零' ? '一' : '零';
    l.text = l.chars.map(x => x.c).join('');
  }
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

  await test('one line displaced by 20px is jitter, not a re-layout', async () => {
    send('capture', A); await settle();
    assert.ok(await markSpan());
    send('capture', jittered(A)); await settle();
    assert.ok(await spanSurvived(), 'one noisy line rebuilt the whole layer');
  });

  await test('one misread character per line is the same page', async () => {
    send('capture', A); await settle();
    assert.ok(await markSpan());
    send('capture', noisy(A)); await settle();
    assert.ok(await spanSurvived(), 'a noisy re-read was taken for a page turn');
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

  await test('two noisy re-reads do not dismiss an open popup', async () => {
    send('capture', A); await settle();
    // page-a's glyphs sit at x≈1950, past this window's viewport, and a click
    // outside the viewport hits nothing. Place the frame so the first glyph
    // lands at (100,100): the layer is translated by frame − screenX/Y.
    const c = A.lines[0].chars[0];
    const [sx, sy] = await js('[window.screenX, window.screenY]');
    send('offset', { fx: sx + 100 - c.x, fy: sy + 100 - c.y }); await settle();
    lookupReply = { surface: 'x', matchLength: 1, groups: [], entries: [] };
    send('trigger', { type: 'click', x: 100 + c.w / 2, y: 100 + c.h / 2 });
    await settle(120);
    assert.strictEqual(await popupShown(), true, 'no popup to protect');
    send('capture', noisy(A)); await settle();
    send('capture', noisy(A)); await settle();
    assert.strictEqual(await popupShown(), true,
                       'popup dismissed by two re-reads of the same page');
    send('dismiss'); await settle();
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

  // --- Anki ------------------------------------------------------------------
  // page-b, horizontal: 吾輩は猫である。… — the popup answers for 吾輩 at the
  // start of line 0, placed so the first glyph lands at (100,100).
  const ankiButtons = () => js("document.querySelectorAll('#popup .anki').length");
  const ankiState = () => js("document.querySelector('#popup .anki').dataset.state");
  const WAGAHAI = {
    surface: '吾輩', base: null, matchLength: 2,
    entries: [{ reading: 'わがはい', dict: 'Jitendex', glosses: ['I; me'] }],
    pitch: [{ reading: 'わがはい', position: 0 }], freq: [{ source: 'JPDB', value: 4321 }],
  };
  WAGAHAI.groups = [WAGAHAI];
  async function lookUpWagahai() {
    send('capture', B); await settle();
    const c = B.lines[0].chars[0];
    const [sx, sy] = await js('[window.screenX, window.screenY]');
    send('offset', { fx: sx + 100 - c.x, fy: sy + 100 - c.y }); await settle();
    lookupReply = WAGAHAI;
    send('trigger', { type: 'click', x: 100 + c.w / 2, y: 100 + c.h / 2 });
    await settle(120);
    assert.strictEqual(await popupShown(), true, 'no popup');
  }

  await test('with Anki off, no mark is drawn and the deck is not asked', async () => {
    send('view-config', { images: true, anki: { enabled: false, deck: null } }); await settle();
    await lookUpWagahai();
    assert.strictEqual(await ankiButtons(), 0);
    assert.strictEqual(ipcSeen.ankiFind.length, 0);
    send('dismiss'); await settle();
  });

  await test('with Anki on, the deck is asked once and the mark shows the answer', async () => {
    send('view-config', { images: true, anki: { enabled: true, deck: 'Mining' } });
    await settle();
    await lookUpWagahai();
    assert.strictEqual(await ankiButtons(), 1, 'one mark per card');
    assert.deepStrictEqual(ipcSeen.ankiFind, [['吾輩']]);
    assert.strictEqual(await ankiState(), 'absent');
  });

  await test('a click sends main the note, with the sentence and the word in <b>', async () => {
    ankiIds = [42];
    await js("document.querySelector('#popup .anki').click()");
    await settle(120);
    assert.strictEqual(ipcSeen.ankiAdd.length, 1, 'one note asked for');
    const note = ipcSeen.ankiAdd[0];
    assert.strictEqual(note.expression, '吾輩');
    assert.strictEqual(note.reading, 'わがはい');
    assert.strictEqual(note.sentence, '<b>吾輩</b>は猫である。');
    assert.deepStrictEqual(note.pitch, [0]);
    assert.deepStrictEqual(note.freq, [{ source: 'JPDB', value: 4321 }]);
    assert.match(note.glossary, /data-dictionary="Jitendex"/);
    assert.match(note.glossary, /I; me/);
    assert.strictEqual(note.mainDefinition, '', 'no monolingual dictionary answered');
    assert.ok(note.region && note.region.w > 0 && note.region.h > 0, 'a region to crop');
    assert.strictEqual(await ankiState(), 'present');
  });

  await test('removing takes two clicks, and the second asks main by note id', async () => {
    await js("document.querySelector('#popup .anki').click()");
    await settle();
    assert.strictEqual(await ankiState(), 'confirm');
    assert.strictEqual(ipcSeen.ankiRemove.length, 0, 'one click removes nothing');
    await js("document.querySelector('#popup .anki').click()");
    await settle(120);
    assert.deepStrictEqual(ipcSeen.ankiRemove, [42]);
    assert.strictEqual(await ankiState(), 'absent');
    send('dismiss'); await settle();
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
  ipcMain.handle('anki:find', (_e, words) => {
    ipcSeen.ankiFind.push(words);
    return { ok: true, ids: words.map((_w, i) => ankiIds[i] || null) };
  });
  ipcMain.handle('anki:add', (_e, note) => {
    ipcSeen.ankiAdd.push(note);
    return { ok: true, noteId: 42 };
  });
  ipcMain.handle('anki:remove', (_e, id) => {
    ipcSeen.ankiRemove.push(id);
    return { ok: true };
  });

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
