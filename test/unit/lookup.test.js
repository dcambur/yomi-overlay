// Dictionary lookup: deinflection, prefix scanning, ranking, kanji fallback.
//
// This is the hot path behind every popup, and it is pure and already
// importable, so it needs no harness — just node.
//
//   test/unit/run.sh node       (node:sqlite prints an experimental warning)
//
// It used to run against whatever index.db this machine had, which meant it
// tested nothing anywhere else and stopped testing anything here the moment
// those dictionaries were removed. The index is now built from dictionaries
// generated for the purpose, so the words it looks for are words it put there.
//
// Assertions are about SHAPE and ORDER, not gloss text: 見つけた must resolve to
// 見つける, the longest match must win, and matchLength must be counted in
// glyphs so it indexes spans directly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads it: lookup shows only what settings has enabled, so it
// needs a config that has heard of these dictionaries. paths.js resolves this
// when it is first required.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-home-'));
process.env.YOMI_USER_DIR = HOME;

const mk = require('./fixtures/make-dictionary.js');
const { build } = require(path.resolve(__dirname, '../../app/main/index-builder.js'));
const { lookup, open, close, initTransformer } =
  require(path.resolve(__dirname, '../../app/main/lookup.js'));

const glyphs = (s) => Array.from(s);

// 見つける conjugates, 日本 is a prefix of 日本語, and 人 has a codepoint twin.
// lookup.js gates the single-kanji fallback on the label "KANJIDIC", so the
// kanji fixture must carry that title.
// 神 carries two readings whose bank order and score order DISAGREE: the
// common one is written second. A Yomitan term bank's score is its popularity
// marker, and ignoring it is what put しん above かみ in the popup.
const COMMON_SCORE = 200;
const WORDS = [['見つける', 'みつける'], ['言葉', 'ことば'],
               ['人', 'ひと'], ['日本', 'にほん'], ['日本語', 'にほんご'],
               ['神', 'しん', 0], ['神', 'かみ', COMMON_SCORE]];
const KANJI = ['憑', '人'];

before(async () => {
  const dicts = path.join(HOME, 'dicts');
  fs.mkdirSync(dicts, { recursive: true });
  mk.termDictionary(path.join(dicts, 'words.zip'),
                    { title: 'Words', words: WORDS, shape: 'jmdict' });
  mk.kanjiDictionary(path.join(dicts, 'kanjidic.zip'),
                     { title: 'KANJIDIC', chars: KANJI });
  fs.writeFileSync(path.join(HOME, 'dictionaries.json'),
                   JSON.stringify(['Words', 'KANJIDIC']));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    dictionaries: [{ name: 'Words', enabled: true },
                   { name: 'KANJIDIC', enabled: true }],
  }));
  const db = path.join(HOME, 'index.db');
  build(dicts, db);
  assert.ok(open(db), 'the fixture index did not open');
  await initTransformer();
});

after(() => {
  close();
  fs.rmSync(HOME, { recursive: true, force: true });
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
  const r = lookup(glyphs('日本語'));
  assert.ok(r);
  assert.ok(r.groups.length > 1, 'expected more than one headword group');
  // Yomitan's chain: source length desc first.
  for (let i = 1; i < r.groups.length; i++) {
    assert.ok(r.groups[i - 1].matchLength >= r.groups[i].matchLength,
      `groups out of order at ${i}: `
      + r.groups.map((g) => `${g.surface}(${g.matchLength})`).join(' '));
  }
  assert.strictEqual(r.groups[0].matchLength, r.matchLength);
  assert.strictEqual(r.groups[0].surface, '日本語', 'the longer word first');
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
  // In the kanji dictionary, and deliberately not a headword in the term one.
  const r = lookup(glyphs('憑'));
  assert.ok(r, 'no kanji fallback');
  assert.strictEqual(r.matchLength, 1);
  assert.strictEqual(r.entries[0].dict, 'KANJIDIC');
  assert.ok('on' in r.entries[0] && 'kun' in r.entries[0],
            'kanji entries must keep 音/訓 separate for the popup');
});

test('a word beats the kanji fallback', () => {
  // 人 is in both fixtures. The fallback is a last resort, not a competitor.
  const r = lookup(glyphs('人'));
  assert.ok(r);
  assert.strictEqual(r.groups[0].entries[0].dict, 'Words');
});

test('the commonest reading leads, whatever order the bank is in', () => {
  const r = lookup(glyphs('神'));
  assert.ok(r);
  const readings = r.groups[0].entries.map((e) => e.reading);
  assert.strictEqual(readings[0], 'かみ',
                     `score decides, not bank order (${readings.join(', ')})`);
  assert.ok(readings.includes('しん'), 'the rarer reading is still offered');
});

test('NFKC-normalises the query, so OCR codepoint twins still hit', () => {
  // The CJK-radical variant of 人 renders identically to the normal form but is
  // a different codepoint; OCR emits both.
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
  const long = lookup(glyphs('日本語'), 2);
  assert.ok(long, 'the bounded scan still found the shorter word');
  assert.ok(long.matchLength <= 2, 'maxLen was ignored');
});
