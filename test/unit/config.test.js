// Settings sanitisation.
//
// These values end up in the capture child's argv (--bundle, --window,
// --modifier, --engine, --interval, --votes). spawn() takes an argv array with
// no shell, so nothing here can be injected into a command line; what this
// prevents is a malformed setting producing a child that fails in a way the
// user cannot trace back to a settings field.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { sanitize, load } = require(
  path.resolve(__dirname, '..', '..', 'app', 'main', 'config.js'));

const cur = load();

test('a non-string bundle becomes null rather than reaching --bundle', () => {
  const out = sanitize({ target: { bundle: 123, windowId: 'abc' } }, cur);
  assert.strictEqual(out.target.bundle, null);
  assert.strictEqual(out.target.windowId, null);
});

test('a valid target survives untouched', () => {
  const out = sanitize({ target: { bundle: 'com.amazon.Lassen', windowId: 42, label: 'Kindle' } }, cur);
  assert.deepStrictEqual(out.target, { bundle: 'com.amazon.Lassen', windowId: 42, label: 'Kindle' });
});

test('an unknown modifier or mode falls back instead of reaching --modifier', () => {
  const out = sanitize({ trigger: { modifier: 'evil', mode: 'nonsense', hoverDelayMs: 99999 } }, cur);
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

test('unknown keys pass through, so settings can grow', () => {
  assert.strictEqual(sanitize({ somethingNew: 7 }, cur).somethingNew, 7);
});
