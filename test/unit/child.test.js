// Child-process supervision.
//
// These assertions encode what app/main.js did BEFORE the step-5 split, so
// the extraction is characterization-guarded rather than merely unit-tested
// afterwards. Each one names the behaviour it pins:
//
//   - NDJSON is parsed per LINE, carrying a partial line across chunks
//   - a blank or unparseable line is skipped, not fatal
//   - an unexpected exit restarts after a backoff
//   - the backoff doubles, capped
//   - a healthy result resets it
//   - stop() does NOT restart (the `deliberate` flag)
//   - a stale process's exit cannot schedule a restart over the live one
//   - a child that ignores SIGTERM is escalated to SIGKILL
//   - silence while still running trips the watchdog
//   - a missing binary reports rather than throwing
//
// Runs on plain node with a stub child, so no binary, permission or window is
// involved. Timings are milliseconds, not the production seconds.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { lineSplitter } = require(
  path.resolve(__dirname, '..', '..', 'app', 'main', 'ndjson.js'));
const { SupervisedChild } = require(
  path.resolve(__dirname, '..', '..', 'app', 'main', 'supervised-child.js'));

const STUB = path.join(__dirname, 'fixtures', 'stub-child.js');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** A child wired to the stub, with test-scale timings. */
function stub(mode, o = {}) {
  const lines = [];
  const errors = [];
  const child = new SupervisedChild({
    name: 'stub',
    bin: process.execPath,
    args: () => [STUB, mode, o.arg].filter(x => x !== undefined),
    backoff: o.backoff || { initial: 20, max: 80, factor: 2 },
    watchdog: o.watchdog,
    onLine: (obj) => lines.push(obj),
    onSpawnError: (e) => errors.push(e),
    log: () => {}, logError: () => {},
    ...o.overrides,
  });
  return { child, lines, errors };
}

/** Wait until `fn()` is true, or fail with a useful message. */
async function until(fn, why, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await wait(10);
  }
  assert.fail(`timed out waiting for: ${why}`);
}

// ---- the line splitter on its own -----------------------------------------

test('a JSON object split across chunks is parsed once, intact', () => {
  const got = [];
  const feed = lineSplitter(o => got.push(o));
  feed('{"a":1,');
  feed('"b":2}\n{"a":3');
  assert.deepStrictEqual(got, [{ a: 1, b: 2 }], 'partial line was not carried');
  feed(',"b":4}\n');
  assert.deepStrictEqual(got, [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
});

test('blank and unparseable lines are skipped, not fatal', () => {
  const got = [];
  const feed = lineSplitter(o => got.push(o));
  feed('\n  \nnot json\n{"ok":true}\n');
  assert.deepStrictEqual(got, [{ ok: true }]);
});

// ---- the same, through a real child ---------------------------------------

test('parses NDJSON off a real child stdout', async () => {
  const { child, lines } = stub('lines', { arg: '3' });
  child.start();
  await until(() => lines.length === 3, 'three lines');
  child.stop();
  assert.deepStrictEqual(lines.map(l => l.seq), [0, 1, 2]);
});

test('an object split across three writes arrives once', async () => {
  const { child, lines } = stub('chunked');
  child.start();
  await until(() => lines.length === 1, 'the chunked object');
  child.stop();
  assert.strictEqual(lines[0].note, 'split across writes');
});

test('garbage on stdout does not stop the stream', async () => {
  const { child, lines } = stub('garbage');
  child.start();
  await until(() => lines.length === 1, 'the good line after the garbage');
  child.stop();
  assert.strictEqual(lines[0].survived, true);
});

// ---- restart policy --------------------------------------------------------

test('an unexpected exit restarts the child', async () => {
  const { child, lines } = stub('crash');
  child.start();
  await until(() => lines.length >= 2, 'a restart after the crash');
  const pids = new Set(lines.map(l => l.pid));
  child.stop();
  assert.ok(pids.size >= 2, 'restarted into the same pid — it never respawned');
});

test('the backoff doubles and is capped', async () => {
  const { child } = stub('crash', { backoff: { initial: 10, max: 40, factor: 2 } });
  child.start();
  await until(() => child.backoff >= 40, 'the backoff to reach its cap');
  const atCap = child.backoff;
  await wait(120);
  child.stop();
  assert.strictEqual(atCap, 40, `backoff overshot the cap: ${atCap}`);
  assert.strictEqual(child.backoff, 40, 'backoff kept growing past the cap');
});

test('a healthy result resets the backoff', async () => {
  const { child } = stub('crash', { backoff: { initial: 10, max: 40, factor: 2 } });
  child.start();
  await until(() => child.backoff > 10, 'the backoff to grow');
  child.resetBackoff();
  assert.strictEqual(child.backoff, 10);
  child.stop();
});

test('stop() does not restart — the deliberate flag', async () => {
  const { child, lines } = stub('lines', { arg: '1' });
  child.start();
  await until(() => lines.length === 1, 'the first line');
  await new Promise(r => child.stop(r));
  const seen = lines.length;
  await wait(120);              // several backoff periods
  assert.strictEqual(lines.length, seen, 'a deliberate stop still respawned');
  assert.strictEqual(child.running, false);
});

test('a stale process exiting cannot schedule a restart', async () => {
  const { child } = stub('silent');
  const first = child.start();
  child.start();                       // replace it; `first` is now stale
  const live = child.proc;
  first.kill();
  await wait(150);
  assert.strictEqual(child.proc, live, 'the stale exit replaced the live child');
  assert.strictEqual(child.restartTimer, null, 'a stale exit armed a restart');
  child.stop();
  live.kill();
});

test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
  const { child, lines } = stub('ignore-sigterm');
  const p = child.start();
  await until(() => lines.length === 1, 'the stub to start');
  child.stop();
  assert.strictEqual(p.killed || p.exitCode !== null || p.signalCode !== null, true,
                     'SIGTERM was never even sent');
  // The escalation timer is 1500ms in production; just prove the child dies.
  await until(() => p.exitCode !== null || p.signalCode !== null,
              'the stubborn child to actually die', 4000);
});

// ---- watchdog --------------------------------------------------------------

test('silence while still running trips the watchdog', async () => {
  const notes = [];
  const { child } = stub('silent', {
    watchdog: { silenceMs: 60, checkMs: 20 },
    overrides: { logError: (m) => notes.push(m) },
  });
  child.start();
  const first = child.proc;
  await until(() => child.proc && child.proc !== first,
              'the watchdog to restart a silent child', 3000);
  child.stop();
  assert.ok(notes.some(m => /no output/.test(m)),
    `watchdog restarted without saying why: ${JSON.stringify(notes)}`);
});

test('a talking child is never restarted by the watchdog', async () => {
  const { child } = stub('chunked', { watchdog: { silenceMs: 200, checkMs: 20 } });
  child.start();
  const first = child.proc;
  await wait(150);
  assert.strictEqual(child.proc, first, 'watchdog killed a healthy child');
  child.stop();
});

// ---- spawn failure ---------------------------------------------------------

test('a missing binary is reported, not thrown', async () => {
  const errors = [];
  const child = new SupervisedChild({
    name: 'missing',
    bin: '/nonexistent/yomi',
    args: () => [],
    backoff: { initial: 20, max: 20, factor: 1 },
    onSpawnError: (e) => errors.push(e),
    log: () => {}, logError: () => {},
  });
  child.start();
  await until(() => errors.length > 0, 'a spawn error');
  child.stop();
  assert.strictEqual(errors[0].code, 'ENOENT');
});

// ---- stdin ------------------------------------------------------------------

test('write() reaches the child, and is safe with no child', async () => {
  const { child, lines } = stub('echo');
  assert.strictEqual(child.write('nobody home\n'), false, 'wrote to a dead child');
  child.start();
  assert.strictEqual(child.write('crop 1 0 0 10 10 /tmp/x.png\n'), true);
  await until(() => lines.length === 1, 'the echo');
  child.stop();
  assert.match(lines[0].echo, /^crop 1 /);
});
