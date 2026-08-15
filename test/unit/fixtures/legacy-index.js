// Build an index in the OLD shape, using the old builder.
//
// lookup.js reads two schemas: the one the JS builder writes now, and the one
// `tools/build-index.py` has always written — because an update that made
// someone's existing index stop answering would be a worse failure than any
// storage saving is worth (ARCHITECTURE §8). Testing that claim needs an index
// in the old shape, and the only honest way to get one is to run the old code.
//
// It used to be got by pointing the test at `data/index.db`, which is nobody's
// file but this machine's: on a runner and in a fresh clone the suites skipped,
// so the compatibility guarantee was never actually checked anywhere.
//
// The Python is driven directly rather than through its main(), which has a
// hardcoded list of dictionary filenames and writes to data/. Its loaders and
// its schema are what matter, and those take arguments.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '../../../tools');

/** Is there a python3 to run the old builder with? */
function available() {
  try {
    execFileSync('python3', ['-c', 'import sqlite3'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Index every archive in `dicts` into `out`, in the old shape.
 *
 * `labels` maps filename -> display label, the same mapping build-index.py
 * keeps hardcoded for the dictionaries it knows. Returns the labels in load
 * order, as its manifest does.
 */
function build(dicts, out, labels = {}) {
  const script = `
import json, sqlite3, sys, zipfile
sys.path.insert(0, ${JSON.stringify(TOOLS)})
import importlib.util
spec = importlib.util.spec_from_file_location(
    "legacy_builder", ${JSON.stringify(path.join(TOOLS, 'build-index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

from pathlib import Path
dicts, out, labels = Path(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3])
out.unlink(missing_ok=True)
db = sqlite3.connect(out)
mod.create_schema(db)

loaded = []
for p in sorted(dicts.glob("*.zip")):
    label = labels.get(p.name, p.name.split(".")[0])
    with zipfile.ZipFile(p) as z:
        names = z.namelist()
    if any(n.startswith("term_bank") for n in names):
        if mod.load_terms(p, db, label):
            loaded.append(label)
    elif any(n.startswith("kanji_bank") for n in names):
        if mod.load_kanji(p, db):
            loaded.append(label)
    elif any(n.startswith("term_meta_bank") for n in names):
        # pitch and frequency share the bank name; the second field says which.
        with zipfile.ZipFile(p) as z:
            bank = next(n for n in names if n.startswith("term_meta_bank"))
            first = mod.read_json(z, bank)[0]
        if first[1] == "pitch":
            mod.load_pitch(p, db)
        else:
            freq = {}
            mod.load_freq(p, freq)
            db.executemany("INSERT INTO freq VALUES (?,?,?)",
                           ((t, label, v) for t, v in freq.items()))
            db.commit()

db.execute("CREATE INDEX idx_terms_key ON terms(key)")
db.execute("CREATE INDEX idx_freq_term ON freq(term)")
db.execute("CREATE INDEX idx_pitch_term ON pitch(term)")
db.commit()
db.close()
print(json.dumps(loaded))
`;
  const stdout = execFileSync(
    'python3', ['-c', script, dicts, out, JSON.stringify(labels)],
    { encoding: 'utf8' });
  if (!fs.existsSync(out)) throw new Error('the old builder wrote no index');
  return JSON.parse(stdout.trim().split('\n').pop());
}

module.exports = { available, build };
