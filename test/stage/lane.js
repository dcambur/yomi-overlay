// A lane's main process: an accessory app with the invisible display, the
// guard on the user's own screen, the suite limit, and the summary.

const { app } = require('electron');
const { SUITE_LIMIT_MS, results, note } = require('./harness.js');
const { openDisplay } = require('./display.js');
const { guardUserScreen } = require('./user-screen.js');

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

/**
 * Run `body(D, ctx)` on the invisible display; exit 0 only if every test
 * passed. `prelude(D)`, if given, runs before the suite's time limit starts —
 * a warm-up whose length is known and announced — and what it returns is
 * `ctx`.
 */
function runLane(body, { prelude } = {}) {
  app.whenReady().then(async () => {
    let t0 = Date.now();
    let D = null, guard = null;
    try {
      D = await openDisplay();
      console.log(`display ${D.id} at ${D.x},${D.y} ${D.width}x${D.height}, invisible`);
      guard = guardUserScreen(D);
      const ctx = prelude ? await prelude(D) : null;
      t0 = Date.now();
      setTimeout(() => {
        console.log(`FAIL  the suite ran past ${SUITE_LIMIT_MS / 1000}s — stopped`);
        app.exit(1);                  // process 'exit' kills every child
      }, SUITE_LIMIT_MS);
      await body(D, ctx);
    } catch (e) {
      results.push({ ok: false, name: 'setup', ms: 0 });
      console.log(`FAIL  setup\n        ${e.stack || e.message}`);
    }
    if (guard) {
      const g = guard.stop();
      const bad = [...g.ours.map((w) => `window ${w} on your display`),
                   ...g.focus.map((t) => `took focus at ${t}`)];
      results.push({ ok: !bad.length, name: 'nothing reached your screen', ms: 0 });
      console.log(`${bad.length ? 'FAIL' : 'ok  '}  nothing reached your screen`
                  + (bad.length ? `\n        ${bad.join('\n        ')}` : ''));
      for (const l of g.left) note(`${l} — a Space switch, if it was not you`);
      for (const d of g.declared) note(`took focus, as it said it would — ${d}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed in `
                + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (D) D.close();
    app.exit(failed ? 1 : 0);
  });
}

module.exports = { runLane };
