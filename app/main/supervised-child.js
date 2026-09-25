// A long-lived child process expected to outlive its own crashes.
//
// Spawn, report a spawn failure usefully, parse NDJSON off stdout, restart on
// an unexpected exit with a backoff, do NOT restart when we killed it, escalate
// to SIGKILL if it will not go, and optionally notice it has gone silent while
// still running. Both helpers need all of that; they differ only in the backoff
// and whether they get a watchdog.
//
// test/logic/child.test.js encodes the behaviour.

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { lineSplitter } = require('./ndjson.js');

// Silence is measured on the monotonic clock. On the wall clock a night
// asleep counted as a night of silence, and the watchdog's first check after
// waking restarted a healthy child — whenever that check came before the
// child's first word (test/idle: an 8 h jump, then the check).
const now = () => performance.now();

// A child that has not exited this long after SIGTERM is wedged, not busy.
const KILL_GRACE_MS = 1500;

class SupervisedChild {
  /**
   * @param {object} o
   * @param {string} o.name        short label for diagnostics, e.g. 'ocr'
   * @param {string} o.bin         executable path
   * @param {() => string[]} o.args  built per start, so settings changes land
   *                                 on the next spawn without extra plumbing
   * @param {{initial:number,max:number,factor:number}} o.backoff
   * @param {{silenceMs:number,checkMs:number}} [o.watchdog]  omit for none
   * @param {number} [o.killGraceMs]  how long SIGTERM gets before SIGKILL
   * @param {string} [o.exitHint]  appended to the exit diagnostic
   * @param {(obj:any) => void} [o.onLine]
   * @param {(text:string) => void} [o.onStderr]
   * @param {() => void} [o.onStart]  each spawn, first and every restart
   * @param {(code:number|null, signal:string|null) => void} [o.onExit]  an
   *                                 exit nobody asked for
   * @param {(err:Error) => void} [o.onSpawnError]
   * @param {(msg:string) => void} [o.log]
   * @param {(msg:string) => void} [o.logError]
   */
  constructor(o) {
    this.name = o.name;
    this.bin = o.bin;
    this.buildArgs = o.args || (() => []);
    this.backoffCfg = o.backoff || { initial: 1000, max: 30000, factor: 2 };
    this.watchdogCfg = o.watchdog || null;
    this.killGraceMs = o.killGraceMs || KILL_GRACE_MS;
    // Appended to the exit line. The capture child's exit is almost always
    // explained by its own stderr just above, and saying so has saved real
    // debugging time.
    this.exitHint = o.exitHint || '';
    this.onLine = o.onLine || (() => {});
    this.onStderr = o.onStderr || (() => {});
    this.onSpawnError = o.onSpawnError || (() => {});
    this.onStart = o.onStart || (() => {});
    this.onExit = o.onExit || (() => {});
    this.log = o.log || (() => {});
    this.logError = o.logError || this.log;

    this.proc = null;
    // The kill in flight: {proc, then}. A second stop() or restart() inside
    // the SIGTERM→exit window replaces `then` instead of starting at once —
    // otherwise the first exit still runs its continuation and spawns a
    // second live child that nothing supervises or kills.
    this.stopping = null;
    this.restartTimer = null;
    this.backoff = this.backoffCfg.initial;
    this.lastOutput = 0;
    this.watchdogFired = false;
    this.watchdogTimer = null;
  }

  /** Spawn, or respawn after a backoff. Cancels a pending restart. */
  start() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const args = this.buildArgs();
    const proc = spawn(this.bin, args);
    this.proc = proc;
    this.lastOutput = now();
    this.watchdogFired = false;

    // A ChildProcess with no 'error' listener rethrows, which would take the
    // whole app down before anything is on screen.
    proc.on('error', (err) => {
      if (this.proc === proc) this.proc = null;
      this.onSpawnError(err);
    });

    const split = lineSplitter(this.onLine);
    proc.stdout.on('data', (chunk) => {
      // A child we stopped is still read until its pipe drains. What it wrote
      // before the stop describes the old target: after a retarget it would
      // rebuild the layer the reset just cleared.
      if (proc.deliberate) return;
      // Any stdout at all is proof of life, whatever it says — that is what
      // the watchdog is asking about.
      this.lastOutput = now();
      this.watchdogFired = false;
      split(chunk);
    });

    proc.stderr.on('data', (d) => this.onStderr(d.toString()));

    // A dead child means a permanently dead feature: output stops and nothing
    // ever brings it back. Restart with a backoff so a transient crash
    // self-heals instead of looking like the app quietly stopped working.
    proc.on('exit', (code, signal) => {
      // `deliberate`: we killed it. `this.proc !== proc`: this is a stale
      // process we already replaced, and its exit must not schedule a restart
      // on top of the live one.
      if (proc.deliberate || this.proc !== proc) return;
      this.proc = null;
      this.onExit(code, signal);
      this.logError(`[${this.name}] exited (code=${code} signal=${signal}); ` +
                    `restarting in ${this.backoff}ms` +
                    (this.exitHint ? ` — ${this.exitHint}` : ''));
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.backoff);
      if (this.restartTimer.unref) this.restartTimer.unref();
      this.backoff = Math.min(this.backoff * this.backoffCfg.factor,
                              this.backoffCfg.max);
    });

    this._armWatchdog();
    // Only once it really is running: a binary that cannot be spawned (ENOENT,
    // EACCES) gets 'error' and never 'exit', and a start announced anyway
    // left the menu saying a first read was slow, for good.
    proc.once('spawn', () => this.onStart());
    return proc;
  }

  /** Kill the child without tripping its auto-restart. */
  stop(then) {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this._disarmWatchdog();
    const p = this.proc;
    this.proc = null;
    if (!p) {
      // Nothing to kill, but maybe something still dying: the newest
      // continuation is the one that runs when it has gone.
      if (this.stopping) { this.stopping.then = then; return; }
      if (then) then();
      return;
    }
    p.deliberate = true;
    if (p.exitCode !== null || p.signalCode !== null) { if (then) then(); return; }
    const pending = { proc: p, then };
    this.stopping = pending;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (this.stopping === pending) this.stopping = null;
      if (pending.then) pending.then();
    };
    p.once('exit', finish);
    try { p.kill(); } catch { finish(); return; }
    // Don't let a wedged child block a retarget forever.
    const t = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, this.killGraceMs);
    if (t.unref) t.unref();
  }

  /** Stop, then start again from a clean backoff. */
  restart() {
    this.resetBackoff();
    this.stop(() => this.start());
  }

  /** A healthy result means the process is working; stop backing off. */
  resetBackoff() {
    this.backoff = this.backoffCfg.initial;
  }

  /** Write a line to the child's stdin. False if there is nobody to write to. */
  write(text) {
    if (!this.proc || !this.proc.stdin) return false;
    try { this.proc.stdin.write(text); return true; } catch { return false; }
  }

  get running() {
    return !!this.proc;
  }

  // ---- watchdog ------------------------------------------------------------
  // A live capture process emits a payload, a heartbeat, or an idle marker
  // every pass, so prolonged TOTAL silence means it wedged rather than that
  // the target is off screen. Measured: 40 minutes of nothing from a live
  // process, ended only by a manual restart.

  _armWatchdog() {
    if (!this.watchdogCfg || this.watchdogTimer) return;
    const { silenceMs, checkMs } = this.watchdogCfg;
    this.watchdogTimer = setInterval(() => {
      if (!this.proc || this.restartTimer) return;
      if (now() - this.lastOutput < silenceMs) return;
      // Fires once per silence streak; any stdout resets the flag.
      if (!this.watchdogFired) {
        this.logError(`[${this.name}] no output for ${silenceMs}ms — restarting`);
      }
      this.watchdogFired = true;
      this.restart();
    }, checkMs);
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  _disarmWatchdog() {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }
}

module.exports = { SupervisedChild };
