// The user's own screen, watched while a lane runs: nothing a test opens may
// land on it, take focus from it, or switch its Space.
//
// Only what a test alone can cause fails the lane — a window of ours on a real
// display, or ours becoming the frontmost app. The user's windows all leaving
// the screen at once is what a Space switch looks like from here, but the user
// may be switching Spaces themselves while a lane runs, so that is reported,
// not failed.

const { execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { OCR_BIN } = require(path.join(ROOT, 'app', 'paths.js'));

// Every window a test opens is an Electron's: the stage's and the app's.
const OURS = 'com.github.Electron';
const SAMPLE_MS = 500;

const FRONT = ['-c', 'lsappinfo info -only bundleid "$(lsappinfo front)"'];
const run = (bin, args) => new Promise((resolve) =>
  execFile(bin, args, { timeout: 3000 }, (e, out) => resolve(e ? null : String(out))));

/** Watch until stop(); `stage` is the invisible display, which is ours. */
function guardUserScreen(stage) {
  const onStage = (w) => w.x >= stage.x && w.y >= stage.y &&
    w.x < stage.x + stage.width && w.y < stage.y + stage.height;
  const seen = { ours: [], focus: [], left: [] };
  let before = null;
  let busy = false;
  async function sample() {
    if (busy) return;
    busy = true;
    try {
      const list = await run(OCR_BIN, ['--list-all']);
      const front = await run('/bin/sh', FRONT);
      if (!list) return;
      const shown = JSON.parse(list).filter((w) => w.onScreen && !onStage(w));
      for (const w of shown.filter((x) => x.bundle === OURS)) {
        seen.ours.push(`${w.id} "${w.title}" at ${w.x},${w.y} ${w.width}x${w.height}`);
      }
      if (front && front.includes(OURS)) seen.focus.push(new Date().toISOString());
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
  return {
    /** What was seen: `ours` and `focus` fail a lane; `left` is for a note. */
    stop() {
      clearInterval(timer);
      // Back by the last sample: an app switch or a redraw, more likely than a
      // Space that stayed switched.
      const now = before || new Map();
      const left = seen.left.map((l) => `${l.at}: ${l.apps} left the screen`
        + (l.ids.some((id) => now.has(id)) ? ', and came back' : ''));
      return { ours: [...new Set(seen.ours)], focus: seen.focus, left };
    },
  };
}

module.exports = { guardUserScreen };
