// The crop channel (app/main/crop.js): the JS end of the watch process's
// `crop` command, which the Anki picture is cut through.
//
// The capture child is a double that records what it was asked and replies
// the way CropChannel.swift does — by writing the PNG, then a {crop} line.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCropChannel } = require('../../app/main/crop.js');

function channel() {
  const asked = [];
  const ocrChild = { running: true, write: (line) => { asked.push(line); return true; } };
  return { ...createCropChannel({ ocrChild }), asked, ocrChild };
}

/** Do what the watch process does for the request on `line`. */
function serve(ch, line) {
  const [, id, , , , , file] = line.trim().split(' ');
  fs.writeFileSync(file, 'PNG');
  ch.onCropReply({ id: Number(id), path: file, ok: true });
  return file;
}

const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-crop-')), name);

test('a crop answered in time is the caller\'s to keep', async () => {
  const ch = channel();
  const want = ch.requestCrop({ x: 1, y: 2, w: 3, h: 4 }, tmp('a.png'), 1000);
  const file = serve(ch, ch.asked[0]);
  assert.strictEqual(await want, true);
  assert.ok(fs.existsSync(file), 'the file the caller asked for is gone');
});

test('a crop that arrives after its caller gave up is deleted', async () => {
  const ch = channel();
  const gaveUp = await ch.requestCrop({ x: 1, y: 2, w: 3, h: 4 }, tmp('late.png'), 20);
  assert.strictEqual(gaveUp, false);
  // The watch process drains once per pass, so the answer can come later.
  const file = serve(ch, ch.asked[0]);
  // Deleted off the main thread (fs.unlink), so give it a moment.
  const tick = () => new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 50 && fs.existsSync(file); i++) await tick();
  assert.ok(!fs.existsSync(file), 'a PNG nobody will read was left behind');
});

test('nothing is asked for a path the command line would split', async () => {
  const ch = channel();
  const asked = await ch.requestCrop({ x: 0, y: 0, w: 1, h: 1 }, '/tmp/a b.png', 50);
  assert.strictEqual(asked, false);
  assert.deepStrictEqual(ch.asked, []);
});
