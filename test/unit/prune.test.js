// Removing a dictionary by deleting its rows, not by rebuilding around it.
//
// The claim is equivalence: an index with a dictionary pruned out must hold
// exactly what an index built without that dictionary holds. That is checkable
// directly — build both and compare — and it is the only thing that justifies
// not rebuilding, which used to take ~80 seconds against ~2.6 here.
//
// The old justification for rebuilding ("frequency ordering is global") was
// wrong: frequency rows carry the source they came from, so one dictionary's
// removal cannot disturb another's ranking.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const DICTS = path.join(ROOT, 'data', 'dicts');

process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-prune-'));
const dictionaries = require(path.join(ROOT, 'app/main/dictionaries.js'));
const { build } = require(path.join(ROOT, 'app/main/index-builder.js'));

assert.ok(dictionaries.DICTS_DIR.startsWith(process.env.YOMI_USER_DIR),
          `refusing to run: would write to ${dictionaries.DICTS_DIR}`);

// Two term dictionaries and a frequency list, so the comparison covers a
// removal that leaves neighbours behind and a freq source that must survive.
const PICKS = ['gram-donna.zip', 'KANJIDIC_english.zip',
               'JPDB_v2.2_Frequency_Kana_2024-10-13.zip']
  .filter((n) => fs.existsSync(path.join(DICTS, n)));
const DROP = 'gram-donna.zip';

/** Everything that defines an index's answers, as comparable rows. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = (sql) => db.prepare(sql).all().map((r) => JSON.stringify(r));
  const out = {
    terms: rows('SELECT key, reading, dict, score FROM terms ORDER BY key, dict, reading'),
    kanji: rows('SELECT char, dict FROM kanji ORDER BY char'),
    freq: rows('SELECT term, source, value FROM freq ORDER BY term, source'),
    pitch: rows('SELECT term, reading, position FROM pitch ORDER BY term, position'),
  };
  db.close();
  return out;
}

test('pruning a dictionary equals never having built it', {
  skip: PICKS.length >= 2 && PICKS.includes(DROP) ? false : 'needs sample dictionaries',
}, async (t) => {
  const tmp = process.env.YOMI_USER_DIR;
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // The index we expect to end up with: built from everything except DROP.
  const refDir = path.join(tmp, 'ref');
  fs.mkdirSync(refDir, { recursive: true });
  for (const n of PICKS) {
    if (n !== DROP) fs.copyFileSync(path.join(DICTS, n), path.join(refDir, n));
  }
  const refDb = path.join(tmp, 'ref.db');
  build(refDir, refDb);

  // The index we actually have: built from everything, then pruned.
  fs.mkdirSync(dictionaries.DICTS_DIR, { recursive: true });
  for (const n of PICKS) {
    fs.copyFileSync(path.join(DICTS, n), path.join(dictionaries.DICTS_DIR, n));
  }
  build(dictionaries.DICTS_DIR, dictionaries.INDEX_PATH);

  const entry = dictionaries.installed().find((d) => d.file === DROP);
  const label = dictionaries.labelOf(DROP, entry.kind, entry.name);

  await t.test('the label matches what the build actually stored', () => {
    const db = new DatabaseSync(dictionaries.INDEX_PATH, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM terms WHERE dict = ?').get(label).n;
    db.close();
    assert.ok(n > 0, `${label} has rows to delete`);
  });

  const steps = [];
  await t.test('pruning reports progress and succeeds', () => {
    dictionaries.remove(DROP);
    const r = dictionaries.prune(label, (p) => steps.push(p.step));
    assert.ok(r.pruned, 'pruned rather than falling back');
    assert.ok(steps.length >= 2, `reported progress (${steps.join(', ')})`);
  });

  await t.test('the result is identical to an index built without it', () => {
    const pruned = snapshot(dictionaries.INDEX_PATH);
    const reference = snapshot(refDb);
    for (const table of ['terms', 'kanji', 'freq', 'pitch']) {
      assert.deepStrictEqual(pruned[table], reference[table],
                             `${table} matches a clean build`);
    }
  });

  await t.test('no glossary is left with nothing pointing at it', () => {
    const db = new DatabaseSync(dictionaries.INDEX_PATH, { readOnly: true });
    const orphans = db.prepare(
      'SELECT COUNT(*) AS n FROM glosses WHERE NOT EXISTS'
      + ' (SELECT 1 FROM terms WHERE terms.gloss = glosses.id)').get().n;
    db.close();
    assert.strictEqual(orphans, 0);
  });

  await t.test('the manifest no longer lists it', () => {
    const labels = dictionaries.writeManifest();
    assert.ok(!labels.includes(label), `${label} is gone from the manifest`);
    assert.ok(labels.length > 0, 'the others are still there');
  });
});
