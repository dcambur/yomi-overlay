// Dictionary lookup, against the real index.db.
//
// This code had no test at all, and it is the hot path behind every popup:
// Yomitan deinflection, multi-length prefix scanning, the four-key ranking
// chain, and the single-kanji fallback. It is also pure and already
// importable, so it needs no harness — just node.
//
//   node --test test/unit/            (node:sqlite prints an experimental warning)
//
// Assertions are deliberately about SHAPE and ORDER rather than exact gloss
// text: the dictionaries are user-supplied and their wording is not ours to
// pin. What must hold is that 見つけた resolves to 見つける, that the longest
// match wins, and that matchLength is counted in glyphs so it indexes spans.

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { lookup, open, initTransformer } =
  require(path.resolve(__dirname, '..', '..', 'app', 'main', 'lookup.js'));

const glyphs = (s) => Array.from(s);

before(async () => {
  assert.ok(open(), 'index.db missing — run tools/build-index.py');
  await initTransformer();
});

test('deinflects a conjugated verb to its dictionary form', () => {
  const r = lookup(glyphs('見つけた'));
  assert.ok(r, 'no result for 見つけた');
  assert.strictEqual(r.base, '見つける');
  assert.strictEqual(r.surface, '見つけた');
});

test('matchLength is counted in GLYPHS, so it indexes spans directly', () => {
  const r = lookup(glyphs('見つけた本'));
  assert.ok(r);
  // 見つけた is four glyphs; a UTF-16 offset could not be used to slice spans.
  assert.strictEqual(r.matchLength, 4);
  assert.strictEqual(r.surface.length, r.matchLength);
});

test('longest match wins, and shorter prefixes still appear as groups', () => {
  const r = lookup(glyphs('転生してきた'));
  assert.ok(r);
  assert.ok(r.groups.length > 1, 'expected more than one headword group');
  // Yomitan's chain: source length desc first.
  for (let i = 1; i < r.groups.length; i++) {
    assert.ok(r.groups[i - 1].matchLength >= r.groups[i].matchLength,
      `groups out of order at ${i}: ` +
      r.groups.map(g => `${g.surface}(${g.matchLength})`).join(' '));
  }
  assert.strictEqual(r.groups[0].matchLength, r.matchLength);
});

test('every group carries at least one entry with a dictionary name', () => {
  const r = lookup(glyphs('言葉'));
  assert.ok(r);
  for (const g of r.groups) {
    assert.ok(g.entries.length > 0, `${g.surface} has no entries`);
    for (const e of g.entries) {
      assert.ok(typeof e.dict === 'string' && e.dict.length, 'entry without a dict');
      assert.ok(Array.isArray(e.glosses) && e.glosses.length, 'entry without glosses');
    }
  }
});

test('falls back to the single kanji when no word matches', () => {
  // A kanji unlikely to head a common word on its own.
  const r = lookup(glyphs('憑'));
  assert.ok(r, 'no kanji fallback');
  assert.strictEqual(r.matchLength, 1);
  assert.strictEqual(r.entries[0].dict, 'KANJIDIC');
  assert.ok('on' in r.entries[0] && 'kun' in r.entries[0],
    'kanji entries must keep 音/訓 separate for the popup');
});

test('NFKC-normalises the query, so OCR codepoint twins still hit', () => {
  // Full-width latin and the CJK-radical variant of 人 render identically to
  // their normal forms but are different codepoints; OCR emits both.
  const plain = lookup(glyphs('人'));
  const twin = lookup(['⼈']);            // KANGXI RADICAL MAN
  assert.ok(plain, 'no result for 人');
  assert.ok(twin, 'NFKC normalisation is not being applied to the query');
  assert.strictEqual(twin.surface, plain.surface);
});

test('accepts a plain string as well as a glyph array', () => {
  const a = lookup(glyphs('言葉'));
  const b = lookup('言葉');
  assert.strictEqual(b.surface, a.surface);
  assert.strictEqual(b.matchLength, a.matchLength);
});

test('returns null rather than throwing on empty input', () => {
  assert.strictEqual(lookup([]), null);
  assert.strictEqual(lookup(''), null);
});

test('respects maxLen, so the caller can bound the scan', () => {
  const long = lookup(glyphs('転生してきた'), 2);
  if (long) assert.ok(long.matchLength <= 2, 'maxLen was ignored');
});
