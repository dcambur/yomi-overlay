// The user's own screen, watched while a lane runs: nothing a test opens may
// land on it, take focus from it, or switch its Space.
//
// Only what a test alone can cause fails the lane — a window of ours on a real
// display, or ours becoming the frontmost app. The user's windows all leaving
// the screen at once is what a Space switch looks like from here, but the user
// may be switching Spaces themselves while a lane runs, so that is reported,
// not failed.

const { screen } = require('electron');
const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));

// Every window a test opens is an Electron's: the stage's and the app's.
const OURS = 'com.github.Electron';
const SAMPLE_MS = 500;

const FRONT = ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'];
// The guard running now, so a test can say it is about to take focus.
let current = null;

const run = (bin, args) => new Promise((resolve) =>
  execFile(bin, args, { timeout: 3000 }, (e, out) => resolve(e ? null : String(out))));

/** Watch until stop(); `stage` is the invisible display, which is ours. */
function guardUserScreen(stage) {
  // Theirs: every display but the stage. A window is on one if it covers more
  // than a sliver of it — the app's panel reports 1439,900 1442x900 over a
  // stage at 1440,900, a point's contact with the user's display.
  const theirDisplays = () => screen.getAllDisplays().filter((d) => d.id !== stage.id)
    .map((d) => d.bounds);
  const span = (a, al, b, bl) => Math.max(0, Math.min(a + al, b + bl) - Math.max(a, b));
  const overlap = (w, b) =>
    span(w.x, w.width, b.x, b.width) * span(w.y, w.height, b.y, b.height);
  const onTheirs = (w) => theirDisplays().some((b) => overlap(w, b) > 16);
  const seen = { ours: [], focus: [], left: [], declared: [] };
  let before = null;
  let busy = false;
  let expecting = null;          // what a test said it is taking focus for
  let userFront = null;          // the user's frontmost app, last seen
  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const list = await run(OCR_BIN, ['--list-all']);
      const front = await run('/bin/sh', FRONT);
      if (!list) return;
      const shown = JSON.parse(list).filter((w) => w.onScreen && onTheirs(w));
      for (const w of shown.filter((x) => x.bundle === OURS)) {
        seen.ours.push(`${w.id} "${w.title}" at ${w.x},${w.y} ${w.width}x${w.height}`);
      }
      if (front && front.includes(OURS)) {
        if (expecting) expecting.samples++;
        else seen.focus.push(new Date().toISOString());
      } else if (front) {
        userFront = (front.match(/"([^"]+)"/) || [])[1] || userFront;
      }
      const theirs = new Map(shown.filter((w) => w.bundle !== OURS).map((w) => [w.id, w.app]));
      if (before && before.size && ![...before.keys()].some((id) => theirs.has(id))) {
        const apps = [...new Set(before.values())].join(', ');
        seen.left.push({ at: new Date().toISOString(), ids: [...before.keys()], apps });
      }
      before = theirs;
    } finally { busy = false; }
  }
  const timer = setInterval(sample, SAMPLE_MS);
  sample();
  current = {
    /** A test that must take focus says so, for how long, and gives it back. */
    async takingFocus(why, fn) {
      expecting = { why, samples: 0, t0: Date.now() };
      try { return await fn(); } finally {
        await sample();
        const e = expecting;
        expecting = null;
        const back = await run('/bin/sh', FRONT);
        if (back && back.includes(OURS) && userFront) {
          const activate = `tell application id "${userFront}" to activate`;
          await run('/usr/bin/osascript', ['-e', activate]);
        }
        seen.declared.push(`${e.why}: ${((Date.now() - e.t0) / 1000).toFixed(1)} s`
                           + (userFront ? `, then given back to ${userFront}` : ''));
      }
    },
  };
  return {
    /** What was seen: `ours` and `focus` fail a lane; `left` is for a note. */
    stop() {
      clearInterval(timer);
      current = null;
      // Back by the last sample: an app switch or a redraw, more likely than a
      // Space that stayed switched.
      const now = before || new Map();
      const left = seen.left.map((l) => `${l.at}: ${l.apps} left the screen`
        + (l.ids.some((id) => now.has(id)) ? ', and came back' : ''));
      return { ours: [...new Set(seen.ours)], focus: seen.focus, left,
               declared: seen.declared };
    },
  };
}

/** Run `fn`, which must take focus (a real fullscreen does), and give it back. */
function takingFocus(why, fn) {
  return current ? current.takingFocus(why, fn) : fn();
}

module.exports = { guardUserScreen, takingFocus };
