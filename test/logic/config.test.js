// Settings sanitisation.
//
// These values end up in the capture child's argv (--bundle, --window,
// --modifier, --engine, --interval, --votes). spawn() takes an argv array with
// no shell, so nothing here can be injected into a command line; what this
// prevents is a malformed setting producing a child that fails in a way the
// user cannot trace back to a settings field.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Its own user directory: in a checkout USER_DIR is data/, and this suite
// used to read the real config.json there.
process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-config-'));
const cfg = require(path.resolve(__dirname, '..', '..', 'app', 'main', 'config.js'));
const { sanitize, load } = cfg;

const cur = load();

test('a non-string bundle becomes null rather than reaching --bundle', () => {
  const out = sanitize({ target: { bundle: 123, app: 7, windowId: 'abc' } }, cur);
  assert.strictEqual(out.target.bundle, null);
  assert.strictEqual(out.target.app, null);
  assert.strictEqual(out.target.windowId, null);
});

test('a valid target survives untouched', () => {
  const target = { bundle: 'com.amazon.Lassen', app: null, windowId: 42, label: 'Kindle' };
  const out = sanitize({ target }, cur);
  assert.deepStrictEqual(out.target, target);
});

test('an app with no bundle id is kept by name, and the name labels it', () => {
  // What the picker sends for a CrossOver .exe: --list-all reports bundle "".
  const out = sanitize({ target: { bundle: '', app: 'Game.exe', windowId: null } }, cur);
  assert.deepStrictEqual(out.target,
                         { bundle: null, app: 'Game.exe', windowId: null, label: 'Game.exe' });
});

test('an unknown modifier or mode falls back instead of reaching --modifier', () => {
  const trigger = { modifier: 'evil', mode: 'nonsense', hoverDelayMs: 99999 };
  const out = sanitize({ trigger }, cur);
  assert.strictEqual(out.trigger.modifier, cur.trigger.modifier);
  assert.strictEqual(out.trigger.mode, cur.trigger.mode);
  assert.strictEqual(out.trigger.hoverDelayMs, cur.trigger.hoverDelayMs);
});

test('every real modifier is accepted', () => {
  for (const m of ['shift', 'control', 'option', 'command']) {
    assert.strictEqual(sanitize({ trigger: { modifier: m } }, cur).trigger.modifier, m);
  }
});

test('engine and interval are clamped to what yomi accepts', () => {
  const out = sanitize({ engine: 'rm -rf /', interval: -5 }, cur);
  assert.strictEqual(out.engine, cur.engine);
  assert.strictEqual(out.interval, cur.interval);
  assert.strictEqual(sanitize({ engine: 'vision' }, cur).engine, 'vision');
});

test('voting counts stay in range', () => {
  const out = sanitize({ voting: { passes: 'a', everyN: 0 } }, cur);
  assert.strictEqual(out.voting.passes, cur.voting.passes);
  assert.strictEqual(out.voting.everyN, cur.voting.everyN);
});

test('dictionary entries are normalised, junk dropped', () => {
  const out = sanitize({ dictionaries: [
    { name: 'Jitendex', enabled: 'yes' }, { name: '', enabled: true }, null, { enabled: true },
  ] }, cur);
  assert.deepStrictEqual(out.dictionaries, [{ name: 'Jitendex', enabled: true }]);
});

test('anki settings are normalised and merged over what was there', () => {
  const out = sanitize({ anki: { enabled: 1, deck: '  Mining ', tags: ['a', ' b ', 7, ''],
                                 url: 'ftp://x', key: '' } }, cur);
  assert.deepStrictEqual(out.anki, {
    enabled: true, deck: 'Mining', tags: ['a', 'b'], picture: true,
    url: cur.anki.url, key: null,
  });
  // A partial save keeps the rest: the settings window sends one key at a time.
  const partial = sanitize({ anki: { deck: 'Other' } }, { ...cur, anki: out.anki });
  assert.strictEqual(partial.anki.enabled, true);
  assert.strictEqual(partial.anki.deck, 'Other');
  assert.strictEqual(sanitize({ anki: { deck: '' } }, cur).anki.deck, null);
});

test('unknown keys pass through, so settings can grow', () => {
  assert.strictEqual(sanitize({ somethingNew: 7 }, cur).somethingNew, 7);
});

test('a save writes what was chosen, not every default', () => {
  cfg.save({ anki: { enabled: true, deck: 'Mining' } });
  const onDisk = JSON.parse(fs.readFileSync(cfg.CONFIG_PATH, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk), ['anki'],
                         'defaults written out are frozen for this install');
  assert.strictEqual(cfg.load().engine, 'auto', 'unchosen settings still come from defaults');
  assert.strictEqual(cfg.load().anki.deck, 'Mining');
});

test('saving anything but the target keeps the first-run prompt', () => {
  assert.strictEqual(cfg.targetChosen(), false);
  cfg.save({ target: { bundle: 'com.apple.Safari', windowId: null, label: 'Safari' } });
  assert.strictEqual(cfg.targetChosen(), true);
  const onDisk = JSON.parse(fs.readFileSync(cfg.CONFIG_PATH, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['anki', 'target']);
});
