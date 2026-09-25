// Long idleness, without the wait: the app's main-process clock is moved
// (stage/in-app.js, YOMI_TEST_CLOCK), so a two-minute watchdog or a night away
// takes seconds. What cannot be moved is measured instead, compressed: a day
// of heartbeats is a capture interval at its floor, with memory and the log
// sampled per pass.
//
// The capture helper and the overlay page keep real time. The clock moves only
// the timers and Date of the main process, which is where every long timer is
// (supervised-child.js, overlay-window.js).
//
//   test/run.sh idle               YOMI_IDLE_SOAK_S=600 for a longer soak

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'test', 'stage');
const { test, check, note, waitFor, sleep } = require(path.join(STAGE, 'harness.js'));
const { stageWindow } = require(path.join(STAGE, 'display.js'));
const { appOnStage, watchPid, lookUp, glyphCount } = require(path.join(STAGE, 'app.js'));
const { watch } = require(path.join(STAGE, 'yomi.js'));
const { runLane } = require(path.join(STAGE, 'lane.js'));

const HOUR = 3600e3;
const SOAK_S = Number(process.env.YOMI_IDLE_SOAK_S || 30);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rssKB = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)],
                                           { encoding: 'utf8' }).trim());
const hidden = (cdp) => cdp.eval("document.visibilityState === 'hidden'");
/** Least-squares slope of y over x. */
function slope(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den ? num / den : 0;
}
/** Why the app last restarted its capture child, in its own words. */
const restarts = (app) => app.log().split('\n')
  .filter((l) => /\[ocr\] (exited|no output)|watchdog/.test(l)).slice(-3).join(' / ');

runLane(async (D) => {
  const A = await stageWindow(path.join(STAGE, 'horizontal.html'),
                              { x: 120, y: 90, width: 1000, height: 700 });
  const app = await appOnStage(A, { shim: true, stage: D, clock: true });
  let cdp = null;
  try {
    cdp = await app.page();
    await waitFor('the first glyph layer', () => glyphCount(cdp), 20000);

    await test('a wedged capture child is restarted by the watchdog', async () => {
      const pid = watchPid(app);
      check(pid, 'no capture child');
      process.kill(pid, 'SIGSTOP');           // silent, and still running
      try {
        // The watchdog asks every 30 s whether 120 s have passed silent.
        await app.eval('clock.advance(155000);');
        const next = await waitFor('a new capture child', () => {
          const p = watchPid(app);
          return p && p !== pid && p;
        }, 8000);
        note(`capture child ${pid} → ${next}`);
        check(/no output for 120000ms — restarting/.test(app.log()), 'the log says nothing');
        await waitFor('the old child to be gone', () => !alive(pid), 5000);
      } finally { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
      await waitFor('the glyph layer after the restart', () => glyphCount(cdp), 10000);
      const p = await lookUp(cdp, '猫');
      check(p.text.includes('ねこ'), `popup: ${p.text.slice(0, 80)}`);
    });

    await test('total silence hides the overlay at the 8 s backstop', async () => {
      await waitFor('the panel on screen', async () => !(await hidden(cdp)));
      const pid = watchPid(app);
      process.kill(pid, 'SIGSTOP');
      try {
        await app.eval('clock.advance(8500);');
        await waitFor('the panel to hide', () => hidden(cdp), 3000);
      } finally { process.kill(pid, 'SIGCONT'); }
      await waitFor('the panel back once the child talks', async () => !(await hidden(cdp)),
                    5000);
    });

    await test('an hour with the target away, then back to the same child', async () => {
      const pid = watchPid(app);
      A.win.hide();
      try {
        await waitFor('the panel to hide', () => hidden(cdp), 4000);
        // An hour of the main process's timers, in steps the watchdog could see
        // (under its 120 s), each after the child has had a pass to speak in:
        // the idle markers it sends every pass (~0.3 s) are what keep it from
        // being restarted, as they would over a real hour.
        for (let t = 0; t < HOUR; t += 100e3) {
          await app.eval('clock.advance(100000);');
          await sleep(400);
        }
        check(watchPid(app) === pid, `an idle hour restarted the capture child (${pid} → `
              + `${watchPid(app)}): ${restarts(app)}`);
      } finally { A.win.showInactive(); }
      const back = Date.now();
      await waitFor('the panel back', async () => !(await hidden(cdp)), 4000);
      note(`back ${Date.now() - back}ms after the target`);
      const p = await lookUp(cdp, '猫');
      check(p.text.includes('ねこ'), `popup: ${p.text.slice(0, 80)}`);
    });

    await test('a page given up after two crashes is back on Restart capture', async () => {
      const menu = () => app.eval('return rec.menu.map((i) => i.label);');
      const reconnect = () => waitFor('the reloaded page', async () => {
        try { const c = await app.page(); await c.eval('1'); return c; } catch { return null; }
      }, 8000);
      cdp.crash(); cdp.close();
      await sleep(300);
      cdp = await reconnect();
      await waitFor('the layer back', () => glyphCount(cdp), 5000);
      cdp.crash(); cdp.close();          // again, inside 10 s: given up
      cdp = null;
      const stopped = await waitFor('the menu to say the overlay stopped', async () => {
        const m = await menu();
        return m.find((l) => /overlay stopped/.test(l));
      }, 5000);
      note(`menu: ${stopped}`);
      await app.eval("menuClick('Restart capture');");
      cdp = await reconnect();
      await waitFor('the layer after Restart capture', () => glyphCount(cdp), 10000);
      const p = await lookUp(cdp, '猫');
      check(p.text.includes('ねこ'), `popup: ${p.text.slice(0, 80)}`);
      const now = await waitFor('the menu to say it is reading', async () => {
        const m = await menu();
        return m.find((l) => /^Reading stage/.test(l));
      }, 5000);
      note(`menu: ${now}`);
    });

    await test('waking from a night asleep leaves a healthy capture child be', async () => {
      const pid = watchPid(app);
      // Asleep, the wall clock ran and the timers stood still; awake, the
      // watchdog's next check comes before or after the child's next word.
      // This is before.
      await app.eval('clock.jump(8 * 3600e3); clock.advance(30000);');
      await sleep(1500);
      check(watchPid(app) === pid, `the child was restarted on waking (${pid} → `
            + `${watchPid(app)}): ${restarts(app)}`);
    });

  } finally {
    if (cdp) cdp.close();
    await app.quit();
    fs.rmSync(app.dir, { recursive: true, force: true });
  }

  // Once the app has quit: two capture sessions at once stall (CONVENTIONS,
  // gotchas). A static page read for hours is, every pass, a capture, a hash
  // and a heartbeat; at 0.1 s, the interval's floor, a day at the default
  // 0.6 s goes by six times as fast. Memory is judged by its slope after the
  // first read settles, not start against end: the first recognition's
  // buffers are let go over the next seconds (measured 137 MB → 38 MB).
  await test(`${SOAK_S} s of heartbeats: the capture helper does not grow`, async () => {
    const w = watch(['--window', String(A.id)], 0.1);
    try {
      await w.next('a first payload', (m) => m.frame, 0, 20000);
      await sleep(5000);                       // past the voting passes and the settle
      const samples = [];
      const until = Date.now() + SOAK_S * 1000;
      while (Date.now() < until) {
        samples.push({ n: w.count((m) => m.unchanged), kb: rssKB(w.pid) });
        await sleep(1000);
      }
      const passes = samples[samples.length - 1].n - samples[0].n;
      // The second half: the first read's buffers are still being let go in
      // the first (measured 137 MB → 38 MB).
      const late = samples.slice(samples.length >> 1);
      const perPass = slope(late.map((x) => x.n), late.map((x) => x.kb));
      note(`${passes} passes in ${SOAK_S} s; yomi ${samples[0].kb} → `
           + `${samples[samples.length - 1].kb} KB, ${(perPass * 1024).toFixed(1)} B a pass`
           + ` — ${((perPass * 144000) / 1024).toFixed(1)} MB a day at 0.6 s`);
      check(passes > SOAK_S * 3, `only ${passes} passes: not the soak it claims to be`);
      check(perPass * 144000 < 50 * 1024, `yomi grows ${(perPass * 144).toFixed(0)} MB a day`);
    } finally { w.stop(); }
  }, SOAK_S * 1000 + 40000);

  const APP_SOAK = `${SOAK_S} s of heartbeats: the app's main process and its log do not grow`;
  await test(APP_SOAK, async () => {
    const soak = await appOnStage(A, { shim: true, stage: D, config: { interval: 0.1 } });
    try {
      const c = await soak.page();
      await waitFor("the soak app's layer", () => glyphCount(c), 20000);
      c.close();
      await sleep(5000);
      // What the main process still holds once garbage is collected: its RSS
      // saws with V8's collections (measured +6 MB in one 30 s run, -46 MB in
      // another), which hides a slope rather than showing one.
      const held = () => soak.eval('global.gc(); return process.memoryUsage().heapUsed;');
      const samples = [];
      const log0 = soak.log().length;
      const t0 = Date.now();
      const until = t0 + SOAK_S * 1000;
      while (Date.now() < until) {
        samples.push({ s: (Date.now() - t0) / 1000, kb: (await held()) / 1024 });
        await sleep(1000);
      }
      const logPerHour = ((soak.log().length - log0) / SOAK_S) * 3600;
      const perHour = slope(samples.map((x) => x.s), samples.map((x) => x.kb)) * 3600;
      const mb = (kb) => (kb / 1024).toFixed(1);
      const kb = (b) => (b / 1024).toFixed(1);
      note(`main heap ${mb(samples[0].kb)} → ${mb(samples[samples.length - 1].kb)} MB, `
           + `${mb(perHour)} MB an hour at 0.1 s; log ${kb(logPerHour)} KB an hour`);
      check(perHour < 5 * 1024, `the main process holds ${mb(perHour)} MB more an hour`);
      check(logPerHour < 1024 * 1024, `the log grows ${kb(logPerHour)} KB an hour`);
    } finally { await soak.quit(); }
  }, SOAK_S * 1000 + 40000);
});
