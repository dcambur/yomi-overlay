// The bounded test runner every Electron-driven lane shares: a named test, a
// poll with a deadline, and children that die with the suite.

const { execFileSync } = require('child_process');

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

// YOMI_ONLY=text runs only the tests whose names contain it, and says so.
const ONLY = process.env.YOMI_ONLY || null;

async function test(name, fn, limitMs = TEST_LIMIT_MS) {
  if (ONLY && !name.includes(ONLY)) { console.log(`skip  ${name} (YOMI_ONLY)`); return; }
  const t0 = Date.now();
  let why = null;
  try { await bounded(fn(), limitMs, 'the test'); } catch (e) { why = e.message; }
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

/**
 * Kill `child` and everything it started, deepest first. The app's capture
 * children leave on their own when it dies (the screen lane checks that), but
 * a suite must not rely on the code it tests to clean up after it: before they
 * did, a day of runs left five event monitors alive. Walked with pgrep rather
 * than a process group: spawning the app detached (setsid) would start it in a
 * session of its own, a change to how it runs that killing its tree does not
 * need.
 */
function killTree(child) {
  const tree = (pid) => {
    let kids = [];
    try {
      kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
        .split('\n').filter(Boolean).map(Number);
    } catch { /* none */ }
    return [...kids.flatMap(tree), pid];
  };
  for (const pid of tree(child.pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}
process.on('exit', () => { for (const c of children) killTree(c); });

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
  track, killTree, lines,
};
