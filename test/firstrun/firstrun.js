// The first run: someone who has just cloned the project, run setup.sh, and
// launched the app — with nothing chosen, no dictionary, and permissions that
// may or may not be there.
//
// Each case starts from a fresh copy of this checkout's tracked files (what a
// clone would hold: no bin/, no data/), with the app's node_modules linked in
// as setup.sh would have installed them. bin/yomi is fake-yomi.sh, the real
// helper aimed at a window on the invisible display. The app runs through
// stage/in-app.js, so what it would show — Settings, message boxes, System
// Settings links, the menu-bar item — is recorded rather than shown, and the
// user's screen stays out of it (stage/user-screen.js checks).
//
// Permissions cannot be taken away from a running test without the user, and
// must not be: TCC grants belong to them. What the app does without one is
// what it does when the helper says so, and that is what the fake says.
//
//   test/run.sh firstrun

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'test', 'stage');
const { OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));
const { test, check, note, waitFor, sleep } = require(path.join(STAGE, 'harness.js'));
const { stageWindow } = require(path.join(STAGE, 'display.js'));
const { launchApp } = require(path.join(STAGE, 'app.js'));
const { runLane } = require(path.join(STAGE, 'lane.js'));

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-first-'));

/** The tracked files of this checkout, as a fresh clone would have them. */
function freshCopy({ helper = true } = {}) {
  const root = path.join(scratch(), 'yomi-overlay');
  fs.mkdirSync(root);
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z']);
  spawnSync('rsync', ['-a', '--from0', '--files-from=-', `${ROOT}/`, `${root}/`],
            { input: files });
  // What setup.sh's npm step leaves behind.
  const link = (...p) => fs.symlinkSync(path.join(ROOT, ...p), path.join(root, ...p));
  link('app', 'node_modules');
  link('node_modules');
  if (helper) {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(path.join(__dirname, 'fake-yomi.sh'), path.join(root, 'bin', 'yomi'));
    fs.chmodSync(path.join(root, 'bin', 'yomi'), 0o755);
  }
  return root;
}

/** The app from a fresh copy, with the fake helper in `mode`. */
async function firstLaunch(D, target, mode, extra = {}) {
  const root = freshCopy({ helper: mode !== 'none' });
  const calls = path.join(root, 'yomi-calls.log');
  const app = await launchApp({
    root, shim: true, stage: D, clock: extra.clock, config: extra.config,
    env: { YOMI_FAKE: mode, YOMI_REAL: OCR_BIN, YOMI_TEST_WINDOW: String(target.id),
           YOMI_FAKE_LOG: calls, ...(extra.env || {}) },
  });
  const watches = () => {
    try {
      return fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l.includes('--watch'));
    } catch { return []; }
  };
  return { ...app, root, watches };
}

const menu = (app) => app.eval('return rec.menu.map((i) => i.label);');
const dialogs = (app) => app.eval('return rec.dialogs;');
const windows = (app) =>
  app.eval('return rec.windows.filter((w) => !w.panel).map((w) => w.title);');

async function appCases(D, A) {
  await test('a fresh install opens Settings, and asks nothing else', async () => {
    const app = await firstLaunch(D, A, 'wrap');
    try {
      await waitFor('the Settings window', async () =>
        (await windows(app)).includes('Overlay Settings'));
      await sleep(1500);              // time for a permission check to come back
      const d = await dialogs(app);
      check(!d.length, `a dialog at first run: ${JSON.stringify(d[0])}`);
      check(/no dictionary yet/.test(app.log()), 'the log says nothing of the dictionary');
      const settings = await app.page('/settings/settings.html');
      const text = await settings.eval('document.body.innerText');
      settings.close();
      note(`Settings opens on: ${text.replace(/\s+/g, ' ').slice(0, 150)}…`);
    } finally { await app.quit(); }
  });

  await test('the menu-bar item says no window is chosen, and no dictionary', async () => {
    const app = await firstLaunch(D, A, 'wrap');
    try {
      const items = await waitFor('the menu-bar item', async () => {
        const m = await menu(app);
        return m.length && m;
      });
      note(`menu: ${items.filter(Boolean).join(' | ')}`);
      check(items.some((l) => /no window chosen/i.test(l)),
            'the menu names a target the user never chose');
      check(items.some((l) => /no dictionary/i.test(l)),
            'the menu does not say lookups have nothing to answer with');
    } finally { await app.quit(); }
  });

  await test('without Screen Recording it says so once, and points at the pane', async () => {
    const app = await firstLaunch(D, A, 'denied');
    try {
      await waitFor('the permission dialog', async () => (await dialogs(app)).length);
      await sleep(4000);             // the capture child fails and restarts meanwhile
      const d = await dialogs(app);
      check(d.length === 1, `${d.length} dialogs: ${d.map((x) => x.title).join(', ')}`);
      check(d[0].title === 'Screen Recording permission needed', `dialog: ${d[0].title}`);
      const items = await menu(app);
      check(items.includes('⚠ Screen Recording not granted'), `menu: ${items.join(' | ')}`);
      await app.eval("menuClick('Open Privacy settings…');");
      const opened = await app.eval('return rec.opened;');
      check(opened.some((u) => u.includes('Privacy_ScreenCapture')), `opened ${opened}`);
      const n = app.watches().length;
      note(`capture started ${n} times in ~5 s without the permission`);
      check(n >= 2 && n <= 5, `${n} capture starts in ~5 s: not backing off, or not retrying`);
    } finally { await app.quit(); }
  });

  await test('without Accessibility the menu says Shift needs the mouse to move', async () => {
    const app = await firstLaunch(D, A, 'wrap', { env: { YOMI_TEST_AX: '0' } });
    try {
      const items = await waitFor('the Accessibility warning', async () => {
        const m = await menu(app);
        return m.some((l) => /Accessibility not granted/.test(l)) && m;
      });
      check(items.includes('Open Accessibility settings…'), `menu: ${items.join(' | ')}`);
      await app.eval("menuClick('Open Accessibility settings…');");
      const opened = await app.eval('return rec.opened;');
      check(opened.some((u) => u.includes('Privacy_Accessibility')), `opened ${opened}`);
    } finally { await app.quit(); }
  });

  await test('a copy with no helper built says where to build it, once', async () => {
    const app = await firstLaunch(D, A, 'none');
    try {
      await waitFor('the dialog', async () => (await dialogs(app)).length);
      await sleep(2500);             // both children and the check all fail meanwhile
      const d = await dialogs(app);
      check(d.length === 1, `${d.length} dialogs: ${d.map((x) => x.title).join(', ')}`);
      check(d[0].title === 'yomi not found', `dialog: ${d[0].title}`);
      check(d[0].detail.includes(path.join(app.root, 'bin', 'yomi')) &&
            d[0].detail.includes('ocr/build.sh'), `detail: ${d[0].detail}`);
    } finally { await app.quit(); }
  });

  await test('a helper that cannot start says so, not that it is slow', async () => {
    const app = await firstLaunch(D, A, 'none', { clock: true });
    try {
      await waitFor('the dialog', async () => (await dialogs(app)).length);
      await app.eval('clock.advance(10500);');
      await sleep(500);
      const m = await menu(app);
      note(`menu: ${m[0]}`);
      check(!m.some((l) => /minute/.test(l)), `it says to wait: "${m[0]}"`);
      check(m.some((l) => /could not start/i.test(l)), `nothing says capture cannot start: ${m[0]}`);
    } finally { await app.quit(); }
  });

  await test('capture that keeps stopping keeps saying so between restarts', async () => {
    const app = await firstLaunch(D, A, 'denied', { clock: true });
    try {
      await waitFor('the menu to say capture keeps stopping', async () =>
        (await menu(app)).some((l) => /keeps stopping/.test(l)), 10000);
      // Past three more backoffs (2, 4, 8 s), without waiting them.
      for (let i = 0; i < 3; i++) { await app.eval('clock.advance(16000);'); await sleep(400); }
      const seen = await app.eval('return rec.menus;');
      const after = seen.slice(seen.findIndex((l) => /keeps stopping/.test(l)));
      note(`first lines since: ${[...new Set(after)].join(' | ')}`);
      check(!after.some((l) => /^Starting/.test(l)),
            'between restarts the menu went back to "Starting capture…"');
    } finally { await app.quit(); }
  });

  const target = { bundle: null, app: null, windowId: A.id, label: 'stage' };

  await test("a first capture refused, as a rebuilt helper's is, recovers", async () => {
    const app = await firstLaunch(D, A, 'refuse-once', { config: { target, interval: 0.3 } });
    try {
      const cdp = await app.page();
      const t0 = Date.now();
      await waitFor('glyph spans', () => cdp.eval("document.querySelectorAll('.g').length"),
                    10000);
      note(`layer ${Date.now() - t0}ms after the refused capture`);
      cdp.close();
      check(!(await dialogs(app)).length, 'a dialog for a refusal the helper recovers from');
    } finally { await app.quit(); }
  });

  await test('a slow first read says it is starting, then what it reads', async () => {
    const app = await firstLaunch(D, A, 'slow', {
      config: { target, interval: 0.3 }, clock: true, env: { YOMI_FAKE_DELAY: '4' } });
    try {
      await waitFor('the menu-bar item', async () => (await menu(app)).length);
      // Ten seconds of a first read with nothing to show, without waiting them.
      await app.eval('clock.advance(10500);');
      // The timers that came due fire a moment after the clock moved.
      const slow = await waitFor('the menu to say the first read is slow', async () => {
        const m = await menu(app);
        return m.some((l) => /starting/i.test(l) && /minute/i.test(l)) && m;
      }, 2000);
      note(`after 10 s: ${slow[0]}`);
      const reading = await waitFor('the menu to say it is reading', async () => {
        const m = await menu(app);
        return m.some((l) => /^Reading stage/.test(l)) && m;
      }, 10000);
      note(`once read: ${reading[0]}`);
    } finally { await app.quit(); }
  });
}

// --- setup.sh, twice, in a sandbox ----------------------------------------------

// What setup.sh must not reach for real: the keychain, TCC, System Settings,
// codesign, and /Applications (build-app.sh deletes the installed app there).
const SHIMS = {
  security: `#!/bin/bash
echo "security $*" >> "$SHIM_LOG"
case "$1" in
  find-identity)
    [ -e "$SHIM_LOG.identity" ] && echo '  1) ABCDEF "Yomi Overlay Dev"'
    exit 0 ;;
  import) touch "$SHIM_LOG.identity" ;;
esac
exit 0`,
  tccutil: '#!/bin/bash\necho "tccutil $*" >> "$SHIM_LOG"',
  open: '#!/bin/bash\necho "open $*" >> "$SHIM_LOG"',
  codesign: `#!/bin/bash
echo "codesign $*" >> "$SHIM_LOG"
if [ -e "$SHIM_BOX/installed-adhoc" ]; then echo 'designated => cdhash H"0123"'
else echo 'designated => identifier "local.yomioverlay" and certificate leaf = H"abc"'; fi`,
  sleep: '#!/bin/bash\nexit 0',
};

/**
 * A fresh copy whose setup.sh runs without reaching the machine: the shims
 * first on PATH, HOME in the sandbox, dictionaries already there. The
 * codesign shim reports the installed app ad-hoc while `installed-adhoc`
 * exists in the sandbox.
 */
function setupSandbox() {
  const root = freshCopy({ helper: false });
  const box = path.dirname(root);
  const shims = path.join(box, 'shims');
  fs.mkdirSync(shims);
  for (const [name, body] of Object.entries(SHIMS)) {
    fs.writeFileSync(path.join(shims, name), body + '\n', { mode: 0o755 });
  }
  // build-app.sh packages, signs, and replaces /Applications/Yomi Overlay.app.
  fs.writeFileSync(path.join(root, 'tools', 'build-app.sh'),
                   '#!/bin/bash\necho "build-app.sh" >> "$SHIM_LOG"\n', { mode: 0o755 });
  // Dictionaries already downloaded: a small generated one, not the network.
  const mk = require(path.join(ROOT, 'test', 'fixtures', 'make-dictionary.js'));
  fs.mkdirSync(path.join(root, 'data', 'dicts'), { recursive: true });
  mk.termDictionary(path.join(root, 'data', 'dicts', 'first.zip'), { title: 'First' });
  const log = path.join(box, 'calls.log');
  const env = { ...process.env, HOME: path.join(box, 'home'), SHIM_LOG: log, SHIM_BOX: box,
                PATH: `${shims}:${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.YOMI_USER_DIR;
  fs.mkdirSync(env.HOME);
  /** One run of setup.sh: its exit status and the commands it reached for. */
  const run = () => {
    fs.writeFileSync(log, '');
    const r = spawnSync('bash', [path.join(root, 'setup.sh')],
                        { env, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, err: String(r.stderr).slice(-300),
             calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  };
  return { root, box, run };
}

const resetsIn = (r) => r.calls.filter((l) => l.startsWith('tccutil reset')).length;

async function setupCases() {
  await test('a second setup.sh keeps the permissions the first one granted', async () => {
    const { run } = setupSandbox();
    const runs = [run(), run()];
    runs.forEach((r, i) => check(r.status === 0, `run ${i + 1} exited ${r.status}: ${r.err}`));
    const brief = (r) => r.calls.map((l) => l.split(' ').slice(0, 2).join(' ')).join(', ');
    note(`first run:  ${brief(runs[0])}`);
    note(`second run: ${brief(runs[1])}`);
    const made = (r) => r.calls.some((l) => l.startsWith('security import'));
    check(made(runs[0]), 'the first made no identity');
    check(!made(runs[1]), 'the second made another');
    check(!resetsIn(runs[1]), `the second run cleared the grants, ${resetsIn(runs[1])} times`);
  });

  await test("a failed first setup.sh still clears an old ad-hoc build's grants", async () => {
    const { root, box, run } = setupSandbox();
    // An old ad-hoc build is installed, and the first run fails at step 5,
    // after making the identity — npm, a download or the build can.
    fs.writeFileSync(path.join(box, 'installed-adhoc'), '');
    fs.writeFileSync(path.join(root, 'tools', 'build-app.sh'), `#!/bin/bash
echo "build-app.sh" >> "$SHIM_LOG"
[ -e "$SHIM_LOG.failed-once" ] || { touch "$SHIM_LOG.failed-once"; exit 1; }
rm -f "$SHIM_BOX/installed-adhoc"
`, { mode: 0o755 });
    const runs = [run(), run(), run()];
    const resets = runs.map(resetsIn);
    note(`tccutil resets per run: ${resets.join(', ')} (run 1 fails at build-app)`);
    check(runs[0].status !== 0 && runs[1].status === 0, 'the sandbox did not fail as planned');
    check(resets[1] === 2, 'the run that replaced the ad-hoc build left its grants standing');
    check(resets[2] === 0, 'a run after the ad-hoc build was gone cleared the grants again');
  });
}

runLane(async (D) => {
  const A = await stageWindow(path.join(STAGE, 'horizontal.html'),
                              { x: 120, y: 90, width: 1000, height: 700 });
  await appCases(D, A);
  await setupCases();
});
