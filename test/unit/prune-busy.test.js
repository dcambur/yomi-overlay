// A prune that meets a lookup mid-statement.
//
// The main process keeps a read connection to index.db open for lookups, and
// the prune (in the index worker) needs the database to itself to commit. A
// lookup holds its shared lock for 1-13 ms (measured in review), so a hover at
// the moment of commit is rare — but with a busy timeout of 0 it failed the
// prune, and a failed prune falls back to a full rebuild: ~80 s instead of
// seconds (ARCHITECTURE section 13). The reader here is another process, as
// the main process is to the worker.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const mk = require('./fixtures/make-dictionary.js');

process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-busy-'));
const dictionaries = require(path.join(ROOT, 'app/main/dictionaries.js'));
const { build } = require(path.join(ROOT, 'app/main/index-builder.js'));

/** Another process holding a read lock on `db` for `ms` once it prints. */
function reader(db, ms) {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(db)}, { readOnly: true });
    db.exec('BEGIN');
    db.prepare('SELECT COUNT(*) FROM terms').get();   // shared lock, held
    process.stdout.write('holding\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${ms});`;
  const child = spawn(process.execPath, ['-e', script]);
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

test('a prune waits out a lookup rather than failing into a rebuild', async (t) => {
  t.after(() => fs.rmSync(process.env.YOMI_USER_DIR, { recursive: true, force: true }));
  fs.mkdirSync(dictionaries.DICTS_DIR, { recursive: true });
  const dicts = dictionaries.DICTS_DIR;
  mk.termDictionary(path.join(dicts, 'drop.zip'), { title: 'Drop', entries: 50 });
  mk.termDictionary(path.join(dicts, 'keep.zip'), { title: 'Keep', entries: 5 });
  build(dicts, dictionaries.INDEX_PATH);
  const entry = dictionaries.installed().find((d) => d.file === 'drop.zip');
  const label = dictionaries.labelOf('drop.zip', entry.kind, entry.name);
  dictionaries.remove('drop.zip');

  const lookup = await reader(dictionaries.INDEX_PATH, 300);
  const r = dictionaries.prune(label);
  await new Promise((resolve) => lookup.once('exit', resolve));
  assert.ok(r.pruned, 'the prune did not complete');
});
