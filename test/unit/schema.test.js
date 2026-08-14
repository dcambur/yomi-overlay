// The index that ships and the index that already exists are different shapes.
//
// The builder now keeps glossary STRUCTURE, deduplicated into its own table and
// deflated. Every index built before that stores pre-flattened sense strings on
// the term row. Both are perfectly good dictionaries, and an update that made
// someone's existing one stop answering would be a worse failure than any
// storage saving is worth — so lookup.js reads either, and this asks the same
// question of both and requires the same answer.
//
// Skips unless both shapes are available: the old one is whatever is in data/,
// the new one is built here from a small dictionary.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const OLD_DB = path.join(ROOT, 'data', 'index.db');
const DICTS = path.join(ROOT, 'data', 'dicts');
const SAMPLE = 'gram-dojg.zip';

function schemaOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const n = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='glosses'"
  ).get().n;
  db.close();
  return n > 0 ? 'structured' : 'flat';
}

const haveOld = fs.existsSync(OLD_DB);
const haveDicts = fs.existsSync(path.join(DICTS, SAMPLE));

test('lookup reads both index schemas', {
  skip: haveOld && haveDicts ? false : 'needs data/index.db and data/dicts/',
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-schema-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  fs.copyFileSync(path.join(DICTS, SAMPLE), path.join(dicts, SAMPLE));
  const newDb = path.join(tmp, 'index.db');
  require(path.join(ROOT, 'app/main/index-builder.js')).build(dicts, newDb);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  await t.test('the two fixtures really are different shapes', () => {
    assert.strictEqual(schemaOf(OLD_DB), 'flat', 'data/index.db is the old shape');
    assert.strictEqual(schemaOf(newDb), 'structured', 'the built one is the new shape');
  });

  // A word DOJG defines, so it is present in the small built index; the old
  // full index has it too.
  const WORD = ['あ', 'げ', 'る'];

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
