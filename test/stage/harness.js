// The bounded test runner every Electron-driven lane shares: a named test, a
// poll with a deadline, and children that die with the suite.

// --- harness ----------------------------------------------------------------
//
// Every wait is bounded, so a run is either quick or a loud failure: a test
// that hangs is stopped at TEST_LIMIT_MS, and the whole suite at
// SUITE_LIMIT_MS. The screen lane takes ~25 s on an idle machine and ~70 s at
// load 8 (measured), where a 60 s limit failed three passing tests.
const TEST_LIMIT_MS = 20000;
const SUITE_LIMIT_MS = 150000;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, why) => { if (!cond) throw new Error(why); };
const note = (s) => console.log('        ' + s);

/** `promise`, or a rejection naming `what` once `ms` have passed. */
function bounded(promise, ms, what) {
  let timer;
  const late = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took more than ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function test(name, fn) {
  const t0 = Date.now();
  let why = null;
  try { await bounded(fn(), TEST_LIMIT_MS, 'the test'); } catch (e) { why = e.message; }
  const ms = Date.now() - t0;
  results.push({ ok: !why, name, ms });
  console.log(`${why ? 'FAIL' : 'ok  '}  ${name} (${(ms / 1000).toFixed(1)}s)`
              + (why ? `\n        ${why}` : ''));
}

/**
 * Poll until `probe` answers something truthy, and return it. A timeout says
 * what the probe last answered: "waited for the layer" and "the layer came
 * back with 288 of 290 glyphs" are different bugs.
 */
async function waitFor(what, probe, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) {
      const saw = JSON.stringify(v === undefined ? null : v).slice(0, 120);
      throw new Error(`timed out after ${timeout}ms waiting for ${what} (last: ${saw})`);
    }
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

module.exports = {
  TEST_LIMIT_MS, SUITE_LIMIT_MS, results, sleep, check, note, bounded, test, waitFor,
  track, lines,
};
