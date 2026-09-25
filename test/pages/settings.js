// The settings window, loaded the way the app loads it.
//
// dictlist.test.js evaluates settings.js against a fake document, which is fast
// and knows nothing about the page it belongs to. It cannot see the two things
// that hold the window together: that the markup, the stylesheet and the script
// are three files that still find each other, and that the page runs under a
// Content-Security-Policy with no 'unsafe-inline' in it. A CSP violation is not
// an exception — the browser drops the resource and logs — so it is invisible
// to anything but a real page load.
//
// Hidden window, real preload, real IPC channel names, the same shape as
// renderer.js. Nothing appears on screen and nothing is captured.
//
//   test/run.sh pages

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');

let win;
const consoleMessages = [];
// What the page saved, per channel, so a test can assert that a change applied
// itself rather than waiting for the footer button.
const saved = { trigger: 0, dictionaries: 0, config: 0, view: null, target: null,
                anki: null };

// Set to make the bridge itself fail, as a main process older than the page does.
let ankiBridgeDown = false;
// Set to make main refuse a save, as a throw anywhere in ipc.js's handler does.
let savesRefused = false;
let windowListCalls = 0;
// What anki:install does: resolves when the test says so, with what it says.
let installGate = null;
let installs = 0;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); }
  catch (e) { results.push([false, name, e.message]); }
}

const js = (expr) => win.webContents.executeJavaScript(expr);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// What the main process would answer. Two dictionaries, one of them installed,
// so the list has something to draw and the config has an order to show.
const CONFIG = {
  target: { bundle: 'com.apple.Safari', windowId: null, label: 'Safari' },
  dictionaries: [{ name: 'Jitendex', enabled: true }],
  trigger: { mode: 'hold', modifier: 'shift', hoverDelayMs: 250 },
  anki: { enabled: false, deck: null, tags: ['yomi-overlay'], picture: true },
};
// What main/anki.js answers with Anki open and Lapis imported.
const ANKI = { running: true, version: 6, model: true,
               decks: ['Default', 'Mining', 'Novels', 'Novels::Hoshi',
                       'Novels::Hoshi::Vol 1'] };
const CATALOGUE = [
  { id: 'jitendex', label: 'Jitendex', name: 'Jitendex', detail: 'JA-EN', installed: true },
  { id: 'jmnedict', label: 'Names', name: 'JMnedict', detail: 'names', installed: false },
];
const INSTALLED = [
  { file: 'jitendex-yomitan.zip', label: 'Jitendex', name: 'Jitendex',
    title: 'Jitendex', kind: 'term', size: 38e6 },
];
const WINDOWS = [
  { id: 1, bundle: 'com.apple.Safari', app: 'Safari', title: 'A page',
    width: 1200, height: 800, onScreen: true },
  // An app with no bundle id, as --list-all reports a CrossOver .exe.
  { id: 2, bundle: '', app: 'Game.exe', title: 'rig window',
    width: 900, height: 682, onScreen: true },
];

async function run() {
  await test('the page loads with no console errors', () => {
    // A blocked stylesheet or script is reported here and nowhere else.
    const bad = consoleMessages.filter((m) => /refus|violat|error|not allowed/i.test(m));
    assert.deepStrictEqual(bad, [], 'console was not clean');
  });

  await test('the stylesheet is linked and applied', async () => {
    const sheets = await js('document.styleSheets.length');
    assert.strictEqual(sheets, 1, 'exactly one stylesheet, and it loaded');
    const bg = await js('getComputedStyle(document.body).backgroundColor');
    assert.strictEqual(bg, 'rgb(27, 26, 31)', 'body has the palette background');
    // A class that only exists because an inline style attribute was moved into
    // the stylesheet: if the move were wrong, this would inherit .hint's grey.
    const live = await js(
      "getComputedStyle(document.querySelector('.legend.live')).color");
    assert.strictEqual(live, 'rgb(76, 175, 80)', 'the live bullet is green');
  });

  await test('nothing in the page is inline', async () => {
    assert.strictEqual(await js('document.querySelectorAll("style").length'), 0,
                       'no <style> block');
    assert.strictEqual(
      await js('[...document.querySelectorAll("script")].filter((s) => !s.src).length'), 0,
      'no inline <script>');
    // Runtime too, not just the source: hiding a row sets a class rather than
    // element.style, so nothing acquires a style attribute after load either.
    // (check-conventions.sh makes the same check against the FILES, which is
    // where a hand-written style="" would appear.)
    assert.strictEqual(await js('document.querySelectorAll("[style]").length'), 0,
                       'nothing carries a style attribute');
  });

  await test('the policy forbids inline script and style', async () => {
    const csp = await js(
      "document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]').content");
    assert.ok(!csp.includes('unsafe-inline'), `still permissive: ${csp}`);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
  });

  await test('the script ran and rendered what the bridge returned', async () => {
    assert.strictEqual(await js("document.querySelectorAll('#dictlist .dict').length"), 2,
                       'one row per dictionary');
    assert.strictEqual(await js("document.querySelectorAll('#winlist .win').length"), 2,
                       'one row per window');
    assert.strictEqual(await js("document.getElementById('modifier').value"), 'shift',
                       'the trigger tab reflects the config');
  });

  await test('an app with no bundle id can be chosen, and is saved by name', async () => {
    await js("document.querySelector('[data-tab=\"window\"]').click()");
    await settle();
    await js("[...document.querySelectorAll('#winlist .win .app')]"
             + ".find((e) => e.textContent === 'Game.exe').closest('.win').click()");
    await settle();
    await js("document.getElementById('save').click()");
    await settle();
    assert.deepStrictEqual(saved.target,
                           { bundle: null, app: 'Game.exe', windowId: null, label: 'Game.exe' },
                           'yomi is pointed at the name, since there is no id');
  });

  await test('switching tabs shows the panel it names', async () => {
    await js("document.querySelector('[data-tab=\"dicts\"]').click()");
    await settle();
    assert.ok(await js("document.getElementById('p-dicts').classList.contains('on')"));
    assert.ok(await js("!document.getElementById('p-window').classList.contains('on')"));
  });

  await test('the apply button is shown only where it applies to something', async () => {
    const hidden = () =>
      js("document.getElementById('save').classList.contains('hidden')");
    const click = (t) => js(`document.querySelector('[data-tab="${t}"]').click()`);
    await click('window'); await settle();
    assert.strictEqual(await hidden(), false, 'shown for the target window');
    for (const tab of ['dicts', 'trigger']) {
      await click(tab); await settle();
      assert.strictEqual(await hidden(), true,
                         `hidden on ${tab}, which saves as it changes`);
    }
  });

  await test('changing the trigger saves it without a button', async () => {
    await js("document.querySelector('[data-tab=\"trigger\"]').click()");
    await settle();
    await js("(() => { const m = document.getElementById('mode');"
             + " m.value = 'hover'; m.onchange(); })()");
    await settle();
    assert.strictEqual(saved.trigger, 1, 'the main process was told, once');
    // And the row that no longer applies is hidden rather than left dangling.
    assert.ok(await js(
      "document.getElementById('row-mod').classList.contains('hidden')"));
  });

  await test('images can be turned off, and it applies at once', async () => {
    await js("document.querySelector('[data-tab=\"trigger\"]').click()");
    await settle();
    assert.strictEqual(await js('document.getElementById("images").checked'), true,
                       'on by default — a dictionary that ships images means them');
    await js('(() => { const b = document.getElementById("images");'
             + ' b.checked = false; b.onchange(); })()');
    await settle();
    assert.deepStrictEqual(saved.view, { images: false },
                           'the main process was told, without a button');
  });

  const deck = (p) => `document.querySelector('#decklist .deck[data-path="${p}"]')`;
  const shown = "[...document.querySelectorAll('#decklist .deck')]"
    + '.filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.dataset.path)';

  await test('the Anki tab asks Anki when shown, and lists its decks as a tree', async () => {
    await js("document.querySelector('[data-tab=\"anki\"]').click()");
    await settle();
    assert.ok(await js("document.getElementById('save').classList.contains('hidden')"),
              'nothing to apply: the tab saves as it changes');
    assert.strictEqual(await js("document.querySelectorAll('#decklist .deck').length"), 5,
                       'one row per deck, subdecks included');
    assert.deepStrictEqual(await js(shown), ['Default', 'Mining', 'Novels'],
                           'subdecks start folded away');
    assert.strictEqual(await js(`${deck('Novels')}.querySelector('.sub').textContent`),
                       '1 subdeck', 'a closed parent says what it hides');
    assert.ok(await js("document.getElementById('anki-dot').classList.contains('live')"),
              'open with Lapis is the green dot');
    assert.strictEqual(await js("document.getElementById('anki-state').textContent"), 'Ready');
  });

  await test('a fold opens one level, and choosing a subdeck saves its full path', async () => {
    await js(`${deck('Novels')}.querySelector('.fold').click()`);
    await settle();
    assert.deepStrictEqual(await js(shown), ['Default', 'Mining', 'Novels', 'Novels::Hoshi'],
                           'one level, not the whole subtree');
    assert.strictEqual(saved.anki, null, 'a fold is not a choice');
    await js(`${deck('Novels')}.querySelector('.fold').click()`);
    await js(`${deck('Novels')}.querySelector('.fold').click()`);
    await js(`${deck('Novels::Hoshi')}.querySelector('.fold').click()`);
    await settle();
    await js(`${deck('Novels::Hoshi::Vol 1')}.click()`);
    await settle();
    assert.strictEqual(saved.anki && saved.anki.deck, 'Novels::Hoshi::Vol 1');
    assert.strictEqual(await js("document.querySelectorAll('#decklist .deck.sel').length"), 1);
    // Fold the grandparent: the choice is out of sight, and the row that hides
    // it says so.
    await js(`${deck('Novels')}.querySelector('.fold').click()`);
    await settle();
    assert.deepStrictEqual(await js(shown), ['Default', 'Mining', 'Novels']);
    assert.ok(await js(`${deck('Novels')}.classList.contains('holds-sel')`));
  });

  await test('choosing a deck saves it without a button, and turning Anki on too', async () => {
    await js(`${deck('Mining')}.click()`);
    await settle();
    assert.strictEqual(saved.anki && saved.anki.deck, 'Mining');
    assert.strictEqual(await js("document.querySelectorAll('#decklist .deck.sel').length"), 1);
    await js("(() => { const b = document.getElementById('anki-on');"
             + ' b.checked = true; b.onchange(); })()');
    await settle();
    assert.strictEqual(saved.anki.enabled, true);
    assert.strictEqual(saved.anki.deck, 'Mining', 'one object carries every key');
  });

  await test('a bridge that rejects is shown as not answering, not left checking', async () => {
    ankiBridgeDown = true;
    await js("document.getElementById('anki-refresh').click()");
    await settle();
    ankiBridgeDown = false;
    assert.strictEqual(await js("document.getElementById('anki-state').textContent"),
                       'Not answering');
    assert.match(await js("document.getElementById('anki-detail').textContent"),
                 /No handler registered/);
    assert.ok(await js("document.getElementById('anki-dot').classList.contains('idle')"));
    assert.strictEqual(await js("document.querySelectorAll('#decklist .deck').length"), 1,
                       'the chosen deck is still listed, alone');
  });

  const displayed = (id) => js(`getComputedStyle(document.getElementById('${id}')).display`
                           + " !== 'none'");
  const text = (id) => js(`document.getElementById('${id}').textContent`);

  await test('Ready: no install row', async () => {
    await js("document.getElementById('anki-refresh').click()");
    await settle();
    assert.strictEqual(await text('anki-state'), 'Ready');
    assert.strictEqual(await displayed('anki-install-row'), false);
  });

  await test('No Lapis: the row says what installing adds, and a click installs', async () => {
    ANKI.model = false;
    await js("document.getElementById('anki-refresh').click()");
    await settle();
    assert.strictEqual(await text('anki-state'), 'No Lapis');
    assert.strictEqual(await displayed('anki-install-row'), true);
    assert.match(await text('anki-install-text'), /github\.com\/donkuri\/lapis.*No deck, no notes/);
    assert.strictEqual(await displayed('anki-install-prog'), false, 'no bar before a click');

    let finish;
    installGate = new Promise((r) => { finish = r; });
    await js("document.getElementById('anki-install').click()");
    await settle();
    assert.strictEqual(installs, 1);
    assert.strictEqual(await displayed('anki-install-prog'), true, 'a bar while installing');
    assert.ok(await js("document.getElementById('anki-install').disabled"));
    assert.match(await text('anki-install-text'), /Downloading/);

    ANKI.model = true;
    finish({ ok: true });
    await settle(120);
    assert.strictEqual(await text('anki-state'), 'Ready', 'checked again after');
    assert.strictEqual(await displayed('anki-install-row'), false);
  });

  await test('an install that fails says why, and the button stays to try again', async () => {
    ANKI.model = false;
    installGate = Promise.resolve({ ok: false, error: 'GitHub did not answer for back.html' });
    await js("document.getElementById('anki-refresh').click()");
    await settle();
    await js("document.getElementById('anki-install').click()");
    await settle(120);
    assert.strictEqual(await text('anki-install-text'),
                       'Not installed: GitHub did not answer for back.html');
    assert.strictEqual(await displayed('anki-install-prog'), false);
    assert.strictEqual(await js("document.getElementById('anki-install').disabled"), false);
    assert.strictEqual(await text('anki-install'), 'Install Lapis', 'the same name throughout');
    ANKI.model = true;
    installGate = null;
  });

  await test('main can ask for a tab, as a popup mark does', async () => {
    await js("document.querySelector('[data-tab=\"window\"]').click()");
    win.webContents.send('settings:tab', 'anki');
    await settle();
    const ankiTabOn = "document.querySelector('[data-tab=\"anki\"]').classList.contains('on')";
    assert.ok(await js(ankiTabOn));
    win.webContents.send('settings:tab', 'nonsense');
    await settle();
    assert.ok(await js(ankiTabOn), 'an unknown tab changes nothing');
  });

  await test('tags are split on spaces and shown back tidy', async () => {
    await js("(() => { const t = document.getElementById('anki-tags');"
             + " t.value = '  novel   yomi-overlay '; t.onchange(); })()");
    await settle();
    assert.deepStrictEqual(saved.anki.tags, ['novel', 'yomi-overlay']);
    assert.strictEqual(await js("document.getElementById('anki-tags').value"),
                       'novel yomi-overlay');
  });

  await test('a save main refuses says so, instead of "saved"', async () => {
    savesRefused = true;
    await js("document.querySelector('[data-tab=\"trigger\"]').click()");
    await js("(() => { const m = document.getElementById('mode');"
             + " m.value = 'hold'; m.onchange(); })()");
    await settle(120);
    const trig = await js("document.getElementById('status').textContent");
    await js("document.querySelector('[data-tab=\"window\"]').click()");
    await js("document.getElementById('save').click()");
    await settle(120);
    const apply = await js("document.getElementById('status').textContent");
    savesRefused = false;
    assert.match(trig, /not saved.*disk full/, `the trigger tab says: ${trig}`);
    assert.match(apply, /not saved.*disk full/, `the footer says: ${apply}`);
  });

  await test('the window list is polled only while its tab is shown', async () => {
    await js("document.querySelector('[data-tab=\"anki\"]').click()");
    const before = windowListCalls;
    await settle(2200);      // the poll runs every 2s
    assert.strictEqual(windowListCalls, before, 'yomi --list-all ran for a hidden list');
    await js("document.querySelector('[data-tab=\"window\"]').click()");
    // Shown again, it catches up on the next tick — no need to sit out a
    // whole period to see that.
    for (let t = 0; t < 25 && windowListCalls === before; t++) await settle(100);
    assert.ok(windowListCalls > before, 'the shown list stopped tracking the windows');
  });

  const failed = results.filter(([ok]) => !ok);
  console.log('== settings ==');
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${err ? '\n        ' + err : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return failed.length;
}

/** Run the suite in this (ready) Electron process; resolves to its failures. */
module.exports = async () => {
  ipcMain.handle('cfg:get', () => CONFIG);
  ipcMain.handle('cfg:windows', () => { windowListCalls++; return WINDOWS; });
  ipcMain.handle('cfg:save', (_e, v) => {
    if (savesRefused) throw new Error('disk full');
    saved.config++; saved.target = v.target; return CONFIG;
  });
  ipcMain.handle('cfg:trigger', () => {
    if (savesRefused) throw new Error('disk full');
    saved.trigger++; return CONFIG;
  });
  ipcMain.handle('cfg:view', (_e, v) => { saved.view = v; return CONFIG; });
  ipcMain.handle('cfg:dictionaries', () => { saved.dictionaries++; return CONFIG; });
  ipcMain.handle('cfg:anki', (_e, v) => { saved.anki = v; return CONFIG; });
  ipcMain.handle('anki:status', () => {
    if (ankiBridgeDown) throw new Error('No handler registered for anki:status');
    return ANKI;
  });
  ipcMain.handle('anki:install', () => { installs++; return installGate; });
  ipcMain.handle('dict:catalogue', () => CATALOGUE);
  ipcMain.handle('dict:installed', () => INSTALLED);
  ipcMain.on('cfg:close', () => {});

  win = new BrowserWindow({
    show: false, width: 560, height: 520,
    webPreferences: {
      // The REAL preload and the real isolation settings, exactly as
      // settings-window.js creates it.
      preload: path.join(ROOT, 'app', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', ({ message }) => {
    consoleMessages.push(message);
    if (process.env.VERBOSE) console.log('    [settings]', message);
  });
  await win.loadFile(path.join(ROOT, 'app', 'settings', 'settings.html'));
  await settle(200);
  const failed = await run();
  win.destroy();
  return failed;
};
