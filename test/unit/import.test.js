// Importing several archives at once — what the file picker allows.
//
// The dialog is opened with multiSelections, so "three dictionaries" is one
// import: three copies and ONE index rebuild, which is the point of doing it
// in a single job. What this pins is the part that is easy to get wrong — what
// happens when one of the three is not a dictionary, which is exactly the case
// a multi-select makes likely (a whole downloads folder, selected at once).
//
// importFiles() is the real one — ipc.js hands it exactly what the dialog
// returned. Only the dialog itself is missing, because a test cannot answer
// one.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const mk = require('./fixtures/make-dictionary.js');

process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-imp-'));
const dictionaries = require(path.join(ROOT, 'app/main/dictionaries.js'));

assert.ok(dictionaries.DICTS_DIR.startsWith(process.env.YOMI_USER_DIR),
          `refusing to run: would write to ${dictionaries.DICTS_DIR}`);

/** Somewhere to pick files FROM, which is not the dictionaries directory. */
const SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-picked-'));
mk.termDictionary(path.join(SRC, 'one.zip'), { title: 'One', entries: 6 });
mk.termDictionary(path.join(SRC, 'two.zip'), { title: 'Two', entries: 6 });
mk.kanjiDictionary(path.join(SRC, 'three.zip'), { title: 'Three' });
mk.notADictionary(path.join(SRC, 'junk.zip'));

const labelsIn = (db) => {
  const d = new DatabaseSync(db, { readOnly: true });
  const rows = d.prepare('SELECT DISTINCT dict FROM terms').all()
    .concat(d.prepare('SELECT DISTINCT dict FROM kanji').all());
  d.close();
  return rows.map((r) => r.dict).sort();
};

// Once, at the end: the tests below share the imported state on purpose, each
// one carrying on from where the last left off.
after(() => {
  fs.rmSync(process.env.YOMI_USER_DIR, { recursive: true, force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
});

test('three at once become three dictionaries and one rebuild', async () => {
  const picked = ['one.zip', 'two.zip', 'three.zip'].map((n) => path.join(SRC, n));
  const r = dictionaries.importFiles(picked);
  assert.deepStrictEqual(r.failed, [], 'all three were readable');
  assert.strictEqual(r.added.length, 3);

  let builds = 0;
  await dictionaries.rebuildAsync(() => { builds++; });
  assert.ok(builds > 0, 'the index was built');
  assert.deepStrictEqual(labelsIn(dictionaries.INDEX_PATH), ['One', 'Three', 'Two']);
  assert.deepStrictEqual(dictionaries.writeManifest().sort(), ['One', 'Three', 'Two'],
                         'and all three are listed');
});

test('one bad archive does not strand the good ones', async () => {
  // The case a multi-select makes likely: a folder selected wholesale, with
  // something in it that is not a dictionary. Aborting the loop would leave
  // the archives already copied sitting on disk and OUT of the index — present
  // in the list, answering nothing, with no way to fix it from the window.
  const picked = ['one.zip', 'junk.zip', 'two.zip'].map((n) => path.join(SRC, n));
  const r = dictionaries.importFiles(picked);
  assert.deepStrictEqual(r.failed.map((f) => f.file), ['junk.zip'],
                         'the bad one is reported by name');
  assert.deepStrictEqual(r.added.map((a) => a.file).sort(), ['one.zip', 'two.zip'],
                         'and the others still went in');

  await dictionaries.rebuildAsync(() => {});
  assert.ok(labelsIn(dictionaries.INDEX_PATH).includes('One'),
            'what was imported is in the index');
  assert.ok(!fs.existsSync(path.join(dictionaries.DICTS_DIR, 'junk.zip')),
            'and the archive that is not a dictionary was not kept');
});

test('every archive on disk is one the index knows about', () => {
  // The invariant that makes the settings list truthful: a row is drawn per
  // archive, so an archive the index never took is a row with a Remove button
  // and no senses behind it.
  const onDisk = dictionaries.installed().map((d) => d.label).sort();
  assert.deepStrictEqual(onDisk, labelsIn(dictionaries.INDEX_PATH),
                         'no archive is present but unindexed');
});
