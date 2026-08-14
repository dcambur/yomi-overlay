// The things this change could plausibly have broken.
//
// Adding a dict column to every table, an index for the orphan sweep, and a
// manifest derived from the database rather than from build order are all
// changes with a blast radius beyond the feature that needed them. Each of the
// following is a specific way that could go wrong, checked rather than assumed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const mk = require('./fixtures/make-dictionary.js');
const DICTS = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-src-'));
mk.termDictionary(path.join(DICTS, 'terms.zip'), { title: 'Terms', entries: 12 });
mk.kanjiDictionary(path.join(DICTS, 'kanji.zip'), { title: 'Kanji' });
const PITCH_ENTRIES = 40;
mk.pitchDictionary(path.join(DICTS, 'pitch_y.zip'), { title: 'Pitch', entries: PITCH_ENTRIES });

process.env.YOMI_USER_DIR = process.env.YOMI_USER_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-reg-'));
const dictionaries = require(path.join(ROOT, 'app/main/dictionaries.js'));
const { build } = require(path.join(ROOT, 'app/main/index-builder.js'));

assert.ok(!dictionaries.INDEX_PATH.startsWith(ROOT),
          `refusing to run: index path is ${dictionaries.INDEX_PATH}`);

const have = () => true;

test('an index built before the dict columns is not silently mangled', () => {
  // The shape the previous commit produced: structured glossaries, but no way
  // to say which dictionary a kanji or pitch row came from.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-old-'));
  const file = path.join(tmp, 'index.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE glosses (id INTEGER PRIMARY KEY, h TEXT UNIQUE, blob BLOB);
    CREATE TABLE terms (key TEXT, reading TEXT, gloss INT, score INT, dict TEXT);
    CREATE TABLE freq  (term TEXT, source TEXT, value INT);
    CREATE TABLE kanji (char TEXT PRIMARY KEY, on_yomi TEXT, kun_yomi TEXT, meanings TEXT);
    CREATE TABLE pitch (term TEXT, reading TEXT, position INT);
  `);
  db.close();

  const saved = dictionaries.INDEX_PATH;
  // prune() reads the module's own INDEX_PATH, so point the check at this file
  // by copying it into place rather than reaching into the module.
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.copyFileSync(file, saved);

  const r = dictionaries.prune('anything');
  assert.strictEqual(r.pruned, false, 'refuses to prune');
  assert.match(r.reason, /predates/, `says why: ${r.reason}`);

  // And nothing was deleted on the way to finding that out.
  const check = new DatabaseSync(saved, { readOnly: true });
  const tables = check.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((t) => t.name);
  check.close();
  assert.deepStrictEqual(tables, ['freq', 'glosses', 'kanji', 'pitch', 'terms']);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(saved, { force: true });
});

test('the manifest derived from the database matches build order', {
  skip: false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-man-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  for (const n of ['terms.zip', 'kanji.zip']) {
    fs.copyFileSync(path.join(DICTS, n), path.join(dicts, n));
  }
  // build() writes the manifest from the order it loaded dictionaries in, and
  // that order is the popup's sense priority. writeManifest() reconstructs it
  // from rowids afterwards; if those disagree, removing a dictionary silently
  // reorders the popup.
  const out = path.join(tmp, 'index.db');
  const built = build(dicts, out);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'dictionaries.json'), 'utf8'));
  assert.deepStrictEqual(onDisk, built.labels, 'build wrote what it reported');

  fs.copyFileSync(out, dictionaries.INDEX_PATH);
  const derived = dictionaries.writeManifest();
  assert.deepStrictEqual(derived, built.labels,
                         'derived manifest matches build order');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pitch rows still load after the column was added', {
  skip: false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-pitch-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  fs.copyFileSync(path.join(DICTS, 'pitch_y.zip'), path.join(dicts, 'pitch_y.zip'));
  const out = path.join(tmp, 'index.db');
  const r = build(dicts, out);
  // Exactly what the fixture holds: the regression this guards was pitch rows
  // silently loading as zero once `dict` was added, so an exact count says more
  // than a threshold.
  assert.strictEqual(r.counts['pitch_y.zip'], PITCH_ENTRIES, 'every pitch record loaded');

  const db = new DatabaseSync(out, { readOnly: true });
  const row = db.prepare('SELECT term, reading, position, dict FROM pitch LIMIT 1').get();
  db.close();
  assert.ok(row && typeof row.position === 'number', 'a pitch row is well formed');
  assert.ok(row.dict, 'and knows which dictionary it came from');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lookup still opens an index that has the new columns', {
  skip: false,
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-look-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  fs.copyFileSync(path.join(DICTS, 'terms.zip'), path.join(dicts, 'terms.zip'));
  const out = path.join(tmp, 'index.db');
  build(dicts, out);

  const lookup = require(path.join(ROOT, 'app/main/lookup.js'));
  lookup.close();
  assert.ok(lookup.open(out), 'opens');
  // Any key the dictionary actually has, so this asserts an answer rather than
  // just an open handle.
  const db = new DatabaseSync(out, { readOnly: true });
  const key = db.prepare('SELECT key FROM terms LIMIT 1').get().key;
  db.close();
  const r = lookup.lookup(Array.from(key), 12, null);
  assert.ok(r && r.groups && r.groups.length > 0, `answers for ${key}`);
  lookup.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
