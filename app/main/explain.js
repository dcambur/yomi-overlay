// Sentence explanation: the explain key asks bot-api — `claude -p` on the
// user's own login — what the sentence under the cursor means. The design
// and the reasons for each choice are in docs/EXPLAIN.md.
//
// One-shot child per request, not a server and not a SupervisedChild: the
// renderer's CSP forbids fetch, the answer is a single JSON document, and the
// Python start-up (measured 0.3s) is noise next to the model (5–8s). Nothing
// here parses the answer — it is bot-api's contract, passed to the renderer
// verbatim, so a change to the contract is a change in one place.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { globalShortcut, screen } = require('electron');
const { logf } = require('./log.js');

// Where `uv tool install --editable .` in the bot-api checkout puts the
// executable. `explain.bin` in the settings overrides it.
const DEFAULT_BIN = path.join(os.homedir(), '.local', 'bin', 'bot');
// The model answers in 5–8s (measured, Sonnet with thinking off); 90s covers
// a cold venv plus an overloaded API without leaving a child around for ever.
const TIMEOUT_MS = 90000;
// A whole component tree is ~2 KB; the cap is against a runaway, not a limit.
const MAX_OUTPUT = 4 << 20;

/** bot-api's own error shape, so the renderer has one thing to draw. */
function failure(code, message) {
  return { contract_version: '1', ok: false, error: { code, message } };
}

function createExplain({ overlayWindow, cfg }) {
  let child = null;        // the in-flight request, so quit and a newer press can kill it
  let registered = [];     // accelerators currently held, so a change releases the old ones

  function resolveBin() {
    const bin = cfg.explain().bin || DEFAULT_BIN;
    return fs.existsSync(bin) ? bin : null;
  }

  /**
   * Cursor → window-local, the same conversion the events monitor gets in
   * main.js, and the same refusal when the overlay is not on screen: a key
   * pressed over another window must not explain whatever the layer last
   * held.
   */
  function fire(channel) {
    if (!overlayWindow.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = overlayWindow.bounds();
    const x = p.x - b.x, y = p.y - b.y;
    if (x < 0 || y < 0 || x > b.width || y > b.height) return;
    overlayWindow.send(channel, { x, y });
  }

  function unregister() {
    for (const acc of registered) globalShortcut.unregister(acc);
    registered = [];
  }

  /** (Re)register from the settings. A change of key needs no child restart. */
  function register() {
    unregister();
    const e = cfg.explain();
    if (!e.enabled) return;
    for (const [acc, channel] of [[e.shortcut, 'explain'],
                                  [e.pickerShortcut, 'explain-picker']]) {
      if (!acc) continue;
      if (globalShortcut.register(acc, () => fire(channel))) registered.push(acc);
      // Registration fails silently when another app owns the combination;
      // say so, because the only symptom is a key that does nothing.
      else console.error(`[explain] ${acc} is taken by another app — change it in Settings`);
    }
  }

  /** The request bot-api gets: the sentence, plus whatever the picker chose. */
  function request(sentence) {
    const e = cfg.explain();
    const req = { prompt: sentence, skill: e.skill, component: true };
    if (e.model) req.model = e.model;
    if (e.thinking !== null || e.effort) {
      req.thinking = {};
      if (e.thinking !== null) req.thinking.enabled = e.thinking;
      if (e.effort) req.thinking.effort = e.effort;
    }
    return req;
  }

  /** Ask. Resolves to bot-api's AskResult, ok or not — never rejects. */
  function run(sentence) {
    const bin = resolveBin();
    if (!bin) {
      const how = 'run `uv tool install --editable .` in the bot-api checkout';
      return Promise.resolve(failure('claude_not_found', `bot-api is not installed: ${how}`));
    }
    // A newer press supersedes the one still running; the renderer drops the
    // older reply by sequence, so killing it only saves the tokens.
    if (child) child.kill();
    const started = Date.now();
    const glyphs = Array.from(sentence).length;
    function start(resolve) {
      function done(err, stdout, stderr) {
        if (child === proc) child = null;
        const ms = Date.now() - started;
        let result = null;
        try { result = JSON.parse(stdout); } catch { /* not the contract; handled below */ }
        if (result && typeof result.ok === 'boolean') {
          const tail = result.ok ? `${result.usage.output_tokens} tok` : result.error.code;
          logf(`[explain] ${glyphs} glyphs → ${ms}ms, ${tail}`);
          resolve(result);
        } else if (err && err.killed) {
          logf(`[explain] ${glyphs} glyphs → killed after ${ms}ms`);
          resolve(failure('timeout', `no answer within ${TIMEOUT_MS / 1000}s`));
        } else {
          const why = (stderr || '').trim().split('\n').pop() ||
                      (err ? err.message : 'no output');
          logf(`[explain] ${glyphs} glyphs → failed after ${ms}ms: ${why}`);
          resolve(failure('claude_error', why));
        }
      }
      const opts = { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT };
      const proc = execFile(bin, ['ask', '--request'], opts, done);
      child = proc;
      proc.stdin.end(JSON.stringify(request(sentence)));
    }
    return new Promise(start);
  }

  /** Quit must not leave a `bot ask` running with nobody to answer. */
  function stop() {
    if (child) child.kill();
    child = null;
    unregister();
  }

  return { register, run, stop };
}

module.exports = { createExplain, failure };
