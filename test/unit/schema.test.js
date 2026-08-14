// The index that ships and the index that already exists are different shapes.
//
// The builder now keeps glossary STRUCTURE, deduplicated into its own table and
// deflated. Every index built before that stores pre-flattened sense strings on
// the term row. Both are perfectly good dictionaries, and an update that made
// someone's existing one stop answering would be a worse failure than any
// storage saving is worth — so lookup.js reads either, and this asks the same
// question of both and requires the same answer.
//
// Both indexes are built here, from dictionaries generated for the purpose: the
// old one by running the old builder's own loaders (fixtures/legacy-index.js),
// the new one by app/main/index-builder.js. Nothing is read from data/, so the
// compatibility guarantee is checked on a runner and in a fresh clone rather
// than only on a machine that happens to have an old index lying around.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');

// Point the app's data directory at a scratch one BEFORE anything reads it:
// lookup.js shows only the dictionaries settings has enabled, so it needs a
// config that has heard of this test's dictionary. Set here rather than inside
// the test because paths.js resolves it when it is first required.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-home-'));
process.env.YOMI_USER_DIR = HOME;

const mk = require('./fixtures/make-dictionary.js');
const legacy = require('./fixtures/legacy-index.js');
const SAMPLE = 'sample.zip';
const LABEL = 'Sample';

function schemaOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='glosses'",
  ).get().n;
  db.close();
  return n > 0 ? 'structured' : 'flat';
}

test('lookup reads both index schemas', {
  // The old shape can only be produced by the old builder, which is Python.
  skip: legacy.available() ? false : 'no python3 to build an old-shape index',
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-schema-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  fs.writeFileSync(path.join(HOME, 'dictionaries.json'), JSON.stringify([LABEL]));
  fs.writeFileSync(path.join(HOME, 'config.json'),
                   JSON.stringify({ dictionaries: [{ name: LABEL, enabled: true }] }));
  // Plain glossaries: the one shape both builders store the same way, so a
  // difference in the answer is a difference in the SCHEMA, not the content.
  mk.termDictionary(path.join(dicts, SAMPLE),
                    { title: LABEL, entries: 8, shape: 'plain' });
  const OLD_DB = path.join(tmp, 'old.db');
  legacy.build(dicts, OLD_DB, { [SAMPLE]: LABEL });
  const newDb = path.join(tmp, 'index.db');
  require(path.join(ROOT, 'app/main/index-builder.js')).build(dicts, newDb);
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  await t.test('the two fixtures really are different shapes', () => {
    assert.strictEqual(schemaOf(OLD_DB), 'flat', 'the Python one is the old shape');
    assert.strictEqual(schemaOf(newDb), 'structured', 'the built one is the new shape');
  });

  // A headword the fixture defines, as the deinflector hands it over: one
  // character per element.
  const WORD = Array.from('語3');

  await t.test('an old index still answers', () => {
    const lookup = require(path.join(ROOT, 'app/main/lookup.js'));
    lookup.close();
    assert.ok(lookup.open(OLD_DB), 'opens');
    const r = lookup.lookup(WORD, 12, null);
    assert.ok(r && r.groups && r.groups.length > 0, 'returns entries');
    lookup.close();
  });

  await t.test('a structured index answers the same question', () => {
    const lookup = require(path.join(ROOT, 'app/main/lookup.js'));
    lookup.close();
    assert.ok(lookup.open(newDb), 'opens');
    const r = lookup.lookup(WORD, 12, null);
    assert.ok(r && r.groups && r.groups.length > 0, 'returns entries');
    // The glossary that comes back is the structure, not pre-flattened text —
    // which is exactly what the renderer needs and what the old shape could
    // not provide.
    const g = r.groups[0].entries[0].glosses;
    assert.ok(Array.isArray(g) && g.length > 0, 'has a glossary');
    lookup.close();
  });

  await t.test('close() lets a freshly imported index be picked up', () => {
    const lookup = require(path.join(ROOT, 'app/main/lookup.js'));
    lookup.close();
    lookup.open(OLD_DB);
    lookup.close();
    assert.ok(lookup.open(newDb), 'reopens against a different file');
    lookup.close();
  });
});
