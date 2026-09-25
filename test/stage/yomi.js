// The capture helper, driven the way the app drives it.

const { spawn, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));
const { track, lines, waitFor } = require('./harness.js');

/**
 * One capture: the first payload `yomi --json` prints, or null. 1-3 s as a
 * rule; the first read after `ocr/build.sh` can take ~30 s while Vision
 * compiles its model for the new binary (measured), which fails here — loudly,
 * and once.
 */
function capture(args, timeout = 15000) {
  return new Promise((resolve) => {
    const child = track(spawn(OCR_BIN, ['--json', ...args]));
    let payload = null;
    let err = '';
    lines(child.stdout, (l) => { payload = payload || JSON.parse(l); });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', () => { clearTimeout(timer); resolve({ payload, err }); });
  });
}

/** A long-running watch session, as the app runs it; `interval` in seconds. */
function watch(args, interval = 0.3) {
  const child = track(spawn(OCR_BIN, ['--json', '--watch', '--interval', String(interval),
                                      ...args]));
  const seen = [];
  lines(child.stdout, (l) => seen.push({ at: Date.now(), m: JSON.parse(l) }));
  child.stderr.resume();
  return {
    pid: child.pid,
    /** How many messages so far `pred` accepts. */
    count: (pred) => seen.filter((s) => pred(s.m)).length,
    /** The first message at or after `since` that `pred` accepts. */
    next: (what, pred, since = 0, timeout = 10000) =>
      waitFor(what, () => seen.find((s) => s.at >= since && pred(s.m)), timeout),
    stop: () => child.kill(),
  };
}

const listAll = () => JSON.parse(execFileSync(OCR_BIN, ['--list-all'], { encoding: 'utf8' }));

module.exports = { capture, watch, listAll };
