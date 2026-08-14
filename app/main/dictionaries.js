// Getting dictionaries onto the machine, and turning them into an index.
//
// Two ways in, because there are two kinds of dictionary. The freely licensed
// ones are fetched here by name so nobody has to go and find them; the ones a
// user owns — 三省堂, 明鏡, DOJG — can never ship with the app or be offered for
// download, so those arrive as a file the user already has.
//
// The catalogue mirrors what Yomitan itself recommends (yomitan.wiki/dictionaries),
// checked rather than assumed: Jitendex from stephenmk, JMnedict and KANJIDIC
// from the jmdict-yomitan daily builds, the two frequency lists from Kuuuube.
// Release URLs are resolved when asked rather than pinned, because
// jmdict-yomitan rebuilds daily and a pinned link goes stale within a week.

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { USER_DIR } = require('../paths.js');
const { DatabaseSync } = require('node:sqlite');
const { build, classify, freqLabel, KNOWN_LABELS } = require('./index-builder.js');

const DICTS_DIR = path.join(USER_DIR, 'dicts');
const INDEX_PATH = path.join(USER_DIR, 'index.db');

/**
 * What can be fetched, in the order it should be offered.
 *
 * `file` is the name it lands under, which is also what index-builder.js keys
 * its display labels and priority order off — so these must not be renamed
 * casually.
 */
const CATALOGUE = [
  {
    id: 'jitendex',
    file: 'jitendex-yomitan.zip',
    name: 'Jitendex',
    detail: 'Japanese to English. The one to start with.',
    github: { repo: 'stephenmk/stephenmk.github.io', asset: 'jitendex-yomitan.zip' },
  },
  {
    id: 'jmnedict',
    file: 'JMnedict.zip',
    name: 'JMnedict',
    detail: 'Names of people, places and organisations.',
    github: { repo: 'yomidevs/jmdict-yomitan', asset: 'JMnedict.zip' },
  },
  {
    id: 'kanjidic',
    file: 'KANJIDIC_english.zip',
    name: 'KANJIDIC',
    detail: 'Readings and meanings for individual kanji.',
    github: { repo: 'yomidevs/jmdict-yomitan', asset: 'KANJIDIC_english.zip' },
  },
  {
    id: 'jpdb',
    file: 'JPDB_frequency.zip',
    name: 'JPDB frequency',
    detail: 'How common a word is. Orders senses in the popup.',
    // Matched rather than named. This repository publishes versioned
    // filenames and keeps the old ones beside the new, so a pinned name
    // silently keeps fetching a stale build — v2.1 is still sitting next to
    // v2.2 today. The kana variant, because entries are indexed under their
    // reading as well as their surface form.
    tree: {
      repo: 'Kuuuube/yomitan-dictionaries',
      dir: 'dictionaries',
      match: /^JPDB_v[\d.]+_Frequency_Kana_\d{4}-\d{2}-\d{2}\.zip$/,
    },
  },
  {
    id: 'bccwj',
    file: 'BCCWJ_frequency.zip',
    name: 'BCCWJ frequency',
    detail: 'A second frequency source, from a balanced corpus.',
    tree: {
      repo: 'Kuuuube/yomitan-dictionaries',
      dir: 'dictionaries',
      match: /^BCCWJ_SUW_LUW_combined\.zip$/,
    },
  },
];

/** Where a catalogue entry's bytes actually are, asked at download time. */
async function resolveURL(entry) {
  if (entry.url) return entry.url;
  if (entry.tree) {
    const api = `https://api.github.com/repos/${entry.tree.repo}/contents/${entry.tree.dir}`;
    const res = await fetch(api, { headers: { 'User-Agent': 'yomi-overlay' } });
    if (!res.ok) throw new Error(`${entry.tree.repo}: listing failed (${res.status})`);
    const files = (await res.json())
      .filter((f) => entry.tree.match.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const newest = files[files.length - 1];
    if (!newest) throw new Error(`${entry.name}: nothing in ${entry.tree.dir} matches`);
    return newest.download_url;
  }
  const api = `https://api.github.com/repos/${entry.github.repo}/releases/latest`;
  const res = await fetch(api, { headers: { 'User-Agent': 'yomi-overlay' } });
  if (!res.ok) throw new Error(`${entry.github.repo}: release lookup failed (${res.status})`);
  const data = await res.json();
  const asset = (data.assets || []).find((a) => a.name === entry.github.asset);
  if (!asset) {
    throw new Error(`${entry.github.asset} is not in release ${data.tag_name}`);
  }
  return asset.browser_download_url;
}

/** Dictionaries present on this machine, with what the index made of them. */
function installed() {
  if (!fs.existsSync(DICTS_DIR)) return [];
  return fs.readdirSync(DICTS_DIR)
    .filter((n) => n.toLowerCase().endsWith('.zip'))
    .sort()
    .map((file) => {
      const info = classify(path.join(DICTS_DIR, file));
      const cat = CATALOGUE.find((c) => c.file === file);
      return {
        file,
        name: cat ? cat.name : (info.title || file.replace(/\.zip$/i, '')),
        // What the archive calls ITSELF, which is how two files are recognised
        // as the same dictionary regardless of what they were named on disk.
        title: info.title || '',
        kind: info.kind,
        size: fs.statSync(path.join(DICTS_DIR, file)).size,
      };
    });
}

/** The catalogue, marked up with what is already here. */
function catalogue() {
  const have = new Set(installed().map((d) => d.file));
  return CATALOGUE.map((c) => ({
    id: c.id, name: c.name, detail: c.detail, file: c.file, installed: have.has(c.file),
  }));
}

/**
 * Fetch one catalogue entry. Written to a partial file and renamed, so an
 * interrupted download cannot leave something that looks like a dictionary.
 */
async function download(id, onProgress = () => {}) {
  const entry = CATALOGUE.find((c) => c.id === id);
  if (!entry) throw new Error(`unknown dictionary: ${id}`);
  fs.mkdirSync(DICTS_DIR, { recursive: true });
  const dest = path.join(DICTS_DIR, entry.file);
  const part = dest + '.part';

  const url = await resolveURL(entry);
  const res = await fetch(url, { headers: { 'User-Agent': 'yomi-overlay' } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;

  let got = 0;
  const out = fs.createWriteStream(part);
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) {
        await new Promise((r) => out.once('drain', r));
      }
      onProgress({ name: entry.name, got, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }

  // Only a real dictionary earns the name. A 404 page saved as a zip would
  // otherwise sit in dicts/ and be reported as a broken import forever.
  const info = classify(part);
  if (!info.kind) {
    fs.rmSync(part, { force: true });
    throw new Error(`${entry.name}: downloaded file is not a Yomitan dictionary`);
  }
  fs.renameSync(part, dest);
  // The same dictionary may already be here under whatever name it was
  // imported as; the download is the one that stays.
  const replaced = dropDuplicates(info.title, entry.file);
  return { file: entry.file, kind: info.kind, size: got, replaced };
}

/**
 * Drop an already-installed copy of the same dictionary under another name.
 *
 * A Yomitan archive names itself in index.json, and that is its identity —
 * importing `jitendex.zip` when `jitendex-yomitan.zip` is already here is the
 * same dictionary twice, not two dictionaries. Left alone it is indexed twice
 * under two labels and every sense appears twice in the popup. Importing a
 * newer build of something you already have is the common case, so replacing
 * is what someone means.
 *
 * Matched on title only, never on filename: the file it is being imported from
 * is usually named nothing like the one already installed.
 */
function dropDuplicates(title, keepFile) {
  if (!title) return [];
  const dropped = [];
  for (const d of installed()) {
    if (d.file !== keepFile && d.title && d.title === title) {
      fs.rmSync(path.join(DICTS_DIR, d.file), { force: true });
      dropped.push(d.file);
    }
  }
  return dropped;
}

/** Take a dictionary the user already has. Same validation as a download. */
function importFile(src) {
  const info = classify(src);
  if (!info.kind) throw new Error('not a Yomitan dictionary archive');
  fs.mkdirSync(DICTS_DIR, { recursive: true });
  const file = path.basename(src);
  fs.copyFileSync(src, path.join(DICTS_DIR, file));
  const replaced = dropDuplicates(info.title, file);
  return { file, kind: info.kind, title: info.title, replaced };
}

/** Forget a dictionary. The index still holds it until it is pruned. */
function remove(file) {
  // basename, so a crafted name cannot reach outside the dictionaries folder.
  const target = path.join(DICTS_DIR, path.basename(file));
  if (!fs.existsSync(target)) throw new Error(`no such dictionary: ${file}`);
  fs.rmSync(target);
}

/** What the index calls a dictionary, derived the same way the build did. */
function labelOf(file, kind, title) {
  if (kind === 'freq' || kind === 'pitch') return freqLabel(file);
  return KNOWN_LABELS[file] || title || file.replace(/\.zip$/i, '');
}

/** Can this index have one dictionary deleted out of it, or must it be rebuilt? */
function prunable(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  return cols('kanji').includes('dict') && cols('pitch').includes('dict')
    && cols('terms').includes('dict');
}

/**
 * Delete one dictionary's rows instead of rebuilding the index around it.
 *
 * Removing used to cost a full rebuild — ~80 seconds on twelve dictionaries —
 * justified by frequency ordering being global. That was wrong: frequency rows
 * carry the source they came from, so deleting one dictionary cannot disturb
 * another's ranking. Nothing is recomputed across dictionaries, so nothing has
 * to be rebuilt. Measured on a 2-million-row index: 930 ms to delete the terms
 * and 1,665 ms to drop the glossaries left with nothing pointing at them,
 * against ~80,000 ms.
 *
 * An index built before the dict columns existed cannot be pruned, and says so
 * rather than deleting the wrong rows; the caller rebuilds instead.
 */
function prune(label, onProgress = () => {}) {
  if (!fs.existsSync(INDEX_PATH)) return { pruned: false, reason: 'no index' };
  const db = new DatabaseSync(INDEX_PATH);
  try {
    if (!prunable(db)) return { pruned: false, reason: 'index predates per-dictionary rows' };
    onProgress({ phase: 'pruning', step: 'entries', done: 0, total: 3 });
    db.exec('BEGIN');
    db.prepare('DELETE FROM terms WHERE dict = ?').run(label);
    db.prepare('DELETE FROM kanji WHERE dict = ?').run(label);
    db.prepare('DELETE FROM pitch WHERE dict = ?').run(label);
    db.prepare('DELETE FROM freq  WHERE source = ?').run(label);
    db.exec('COMMIT');

    onProgress({ phase: 'pruning', step: 'glossaries', done: 1, total: 3 });
    db.exec('BEGIN');
    db.exec('DELETE FROM glosses WHERE NOT EXISTS'
            + ' (SELECT 1 FROM terms WHERE terms.gloss = glosses.id)');
    db.exec('COMMIT');

    onProgress({ phase: 'pruning', step: 'finishing', done: 2, total: 3 });
    const left = db.prepare('SELECT COUNT(*) AS n FROM terms').get().n;
    return { pruned: true, rows: left };
  } finally {
    db.close();
  }
}

/** The manifest, rewritten from what is still installed and still indexed. */
function writeManifest() {
  const labels = [];
  if (fs.existsSync(INDEX_PATH)) {
    const db = new DatabaseSync(INDEX_PATH, { readOnly: true });
    try {
      // Build order is the popup's sense priority, and rowid preserves it.
      for (const r of db.prepare(
        'SELECT dict, MIN(rowid) AS first FROM terms GROUP BY dict ORDER BY first').all()) {
        if (r.dict) labels.push(r.dict);
      }
      for (const r of db.prepare('SELECT DISTINCT dict FROM kanji').all()) {
        if (r.dict && !labels.includes(r.dict)) labels.push(r.dict);
      }
    } finally { db.close(); }
  }
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(INDEX_PATH), 'dictionaries.json'),
                   JSON.stringify(labels, null, 2) + '\n');
  return labels;
}

/**
 * Rebuild the index from everything installed.
 *
 * Always everything, never an increment: frequency ordering is global, so
 * adding one dictionary changes how senses from the others rank.
 */
function rebuild(onProgress = () => {}) {
  if (!installed().length) {
    fs.rmSync(INDEX_PATH, { force: true });
    return { labels: [], rows: 0, keys: 0, glosses: 0, counts: {}, skipped: [] };
  }
  return build(DICTS_DIR, INDEX_PATH, onProgress);
}

/**
 * Run a build or a prune off the main process.
 *
 * The synchronous versions are fine for a script and wrong for an app. A build
 * is ~80 seconds on a full set and a prune a few, and the main process is what
 * draws the overlay over whatever the user is reading — so either one freezes
 * it, and a progress message cannot be painted by a process that is busy
 * producing it. Forked as the same binary through ELECTRON_RUN_AS_NODE, so
 * there is no second Node to depend on.
 */
function inWorker(message, onProgress) {
  return new Promise((resolve, reject) => {
    // require.resolve, not a path built from __dirname: one file knows the
    // layout (CONVENTIONS), and the module system already knows where its own
    // sibling lives.
    const child = fork(require.resolve('./index-build-worker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    child.on('message', (m) => {
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') finish(resolve, m.result);
      else if (m.type === 'error') finish(reject, new Error(m.message));
    });
    child.on('error', (e) => finish(reject, e));
    child.on('exit', (code) => {
      finish(reject, new Error(`index worker exited with ${code} before finishing`));
    });
    child.send(message);
  });
}

function rebuildAsync(onProgress = () => {}) {
  if (!installed().length) {
    fs.rmSync(INDEX_PATH, { force: true });
    return Promise.resolve(
      { labels: [], rows: 0, keys: 0, glosses: 0, counts: {}, skipped: [] });
  }
  return inWorker({ type: 'build', dictsDir: DICTS_DIR, outPath: INDEX_PATH },
                  onProgress);
}

function pruneAsync(label, onProgress = () => {}) {
  return inWorker({ type: 'prune', label }, onProgress);
}

module.exports = {
  CATALOGUE, catalogue, installed, download, importFile, remove, rebuild,
  rebuildAsync, pruneAsync, prune, labelOf, writeManifest, dropDuplicates,
  // Exported so the catalogue can be checked for reachability without
  // downloading gigabytes: every entry must still resolve to a real URL.
  resolveURL,
  DICTS_DIR, INDEX_PATH,
};
