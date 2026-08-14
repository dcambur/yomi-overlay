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
//   test/unit/run.sh          (or: electron test/unit/settings.js)

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');

let win;
const consoleMessages = [];

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
};
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
    assert.strictEqual(await js("document.querySelectorAll('#winlist .win').length"), 1,
                       'one row per window');
    assert.strictEqual(await js("document.getElementById('modifier').value"), 'shift',
                       'the trigger tab reflects the config');
  });

  await test('switching tabs shows the panel it names', async () => {
    await js("document.querySelector('[data-tab=\"dicts\"]').click()");
    await settle();
    assert.ok(await js("document.getElementById('p-dicts').classList.contains('on')"));
    assert.ok(await js("!document.getElementById('p-window').classList.contains('on')"));
  });

  const failed = results.filter(([ok]) => !ok);
  for (const [ok, name, err] of results) {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${err ? '\n        ' + err : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  ipcMain.handle('cfg:get', () => CONFIG);
  ipcMain.handle('cfg:windows', () => WINDOWS);
  ipcMain.handle('cfg:save', () => ({ ok: true }));
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
  await run();
});
