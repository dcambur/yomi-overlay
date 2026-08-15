// What happens with dictionaries we did not ship, and without ones we did.
//
// The app knows the names of the dictionaries it offers, and that must stay a
// shortcut rather than the mechanism: someone who imports a kanji dictionary
// that is not KANJIDIC, or a pitch pack that is not NHK, has to get the same
// behaviour. And a reader who has installed none of those must not see the
// space where they would have been.
//
// Every case here is built from generated archives, indexed and looked up for
// real — the classification lives in the builder and in lookup.js, and asking
// them is the only way to know.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-kinds-'));
process.env.YOMI_USER_DIR = HOME;

const ROOT = path.resolve(__dirname, '../..');
const mk = require('./fixtures/make-dictionary.js');
const { build, classify } = require(path.join(ROOT, 'app/main/index-builder.js'));
const lookup = require(path.join(ROOT, 'app/main/lookup.js'));
const cfg = require(path.join(ROOT, 'app/main/config.js'));

/** Build an index from a named subset of fixtures and open it. */
function indexOf(name, make) {
  const dir = path.join(HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  make(dir);
  const db = path.join(HOME, name + '.db');
  const r = build(dir, db);
  fs.writeFileSync(path.join(HOME, 'dictionaries.json'), JSON.stringify(r.labels));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    dictionaries: r.labels.map((n) => ({ name: n, enabled: true })),
  }));
  // config.js caches what it read; the app drops that cache after every
  // rebuild (ipc.js) and a test that does not gets the previous index's list
  // of enabled dictionaries — which silently hides the new one.
  cfg.refreshDictionaries();
  lookup.close();
  assert.ok(lookup.open(db), `${name} did not open`);
  return r;
}

const WORDS = [['語0', 'ご0'], ['語1', 'ご1']];

before(async () => { await lookup.initTransformer(); });
after(() => { lookup.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('a kanji dictionary that is not KANJIDIC still answers', () => {
  // The fallback used to be gated on the literal label "KANJIDIC", so any
  // other kanji dictionary was indexed, listed, enabled — and never consulted.
  indexOf('kanji', (dir) => {
    mk.termDictionary(path.join(dir, 'words.zip'), { title: 'Words', words: WORDS });
    mk.kanjiDictionary(path.join(dir, 'other.zip'),
                       { title: '漢字源', chars: ['鬱'] });
  });
  const r = lookup.lookup(['鬱']);
  assert.ok(r, 'a character no word claims falls back to the kanji dictionary');
  assert.strictEqual(r.entries[0].dict, '漢字源', 'and says which one answered');
  assert.ok('on' in r.entries[0] && 'kun' in r.entries[0]);
});

test('a pitch dictionary that is not NHK is still used', () => {
  // Pitch is recognised by what its banks CONTAIN, not by its name: the
  // second field of each record is the word "pitch".
  indexOf('pitch', (dir) => {
    mk.termDictionary(path.join(dir, 'words.zip'), { title: 'Words', words: WORDS });
    mk.pitchDictionary(path.join(dir, 'accents.zip'), { title: 'アクセント辞典' });
  });
  const r = lookup.lookup(Array.from('語0'));
  assert.ok(r.groups[0].pitch.length > 0, 'the accent came through');
  assert.strictEqual(typeof r.groups[0].pitch[0].position, 'number');
});

test('a frequency list that is not JPDB or BCCWJ is still used', () => {
  indexOf('freq', (dir) => {
    mk.termDictionary(path.join(dir, 'words.zip'), { title: 'Words', words: WORDS });
    mk.freqDictionary(path.join(dir, 'mine_v1.zip'), { title: 'My corpus' });
  });
  const r = lookup.lookup(Array.from('語0'));
  assert.ok(r.groups[0].freq.length > 0, 'the rank came through');
  assert.ok(r.groups[0].freq[0].source, 'and is attributed');
});

test('with no pitch dictionary, nothing claims to know the accent', () => {
  indexOf('nopitch', (dir) => {
    mk.termDictionary(path.join(dir, 'words.zip'), { title: 'Words', words: WORDS });
  });
  const g = lookup.lookup(Array.from('語0')).groups[0];
  assert.deepStrictEqual(g.pitch, [], 'no accent is offered');
  assert.deepStrictEqual(g.freq, [], 'and no frequency');
  // The popup draws the reading alone in that case; what matters here is that
  // the fields are empty rather than absent, so the renderer has no undefined
  // to trip over.
  assert.ok(Array.isArray(g.pitch) && Array.isArray(g.freq));
});

test('with only a pitch dictionary there is nothing to define, and it says so', () => {
  indexOf('pitchonly', (dir) => {
    mk.pitchDictionary(path.join(dir, 'accents.zip'), { title: 'Pitch only' });
  });
  assert.strictEqual(lookup.lookup(Array.from('語0')), null,
                     'an accent is not a definition');
});

test('a dictionary is recognised by its banks, not by its name', () => {
  // This is what makes all of the above work: the builder never reads a
  // filename to decide what an archive is.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-cls-'));
  const cases = [
    ['zzz-unknown-name.zip', (f) => mk.termDictionary(f, { title: 'x' }), 'term'],
    ['aaa.zip', (f) => mk.kanjiDictionary(f, { title: 'x' }), 'kanji'],
    ['nothing-like-nhk.zip', (f) => mk.pitchDictionary(f, { title: 'x' }), 'pitch'],
    ['not-a-corpus.zip', (f) => mk.freqDictionary(f, { title: 'x' }), 'freq'],
  ];
  for (const [name, makeIt, kind] of cases) {
    const file = path.join(dir, name);
    makeIt(file);
    assert.strictEqual(classify(file).kind, kind, `${name} is a ${kind}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
