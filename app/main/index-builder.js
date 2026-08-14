// Building the lookup index from Yomitan dictionary archives.
//
// This runs inside the app so that a user can add a dictionary they own from
// the Settings window — including the commercial monolinguals, which cannot be
// redistributed and therefore cannot ship with the app. It replaces the Python
// builder that used to be the only way in, and which needed a checkout and an
// interpreter macOS has not shipped since 12.3.
//
// *** It stores the glossary STRUCTURE, not flattened text. ***
//
// The Python flattened structured content into sense strings at index time, per
// what was ARCHITECTURE section 8, and taught itself the shape of each
// dictionary it was given: JMdict sense nodes, 三省堂 語義/語釈, the plain-text
// line formats. That works for dictionaries someone has taught it and degrades
// to a permissive walk for everything else — the walk that yields 「き」「ぞく」
// 「［」 as three senses. Since the whole point here is a dictionary nobody
// anticipated, the structure is kept and rendered at display time instead, the
// way Yomitan itself does it.
//
// Plain-string glossaries (明鏡, 旺文社, 実用, DOJG, どんなとき ship one string
// per entry) are stored as they are and split at render time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const zip = require('./zip.js');

// Priority order for dictionaries we know, which is also the order senses
// appear in the popup. Anything else a user imports is appended, identified by
// the banks it contains rather than by name — see classify().
const KNOWN_ORDER = [
  'jitendex-yomitan.zip', 'mono-sankoku8.zip', 'mono-meikyo2.zip',
  'mono-oukoku11.zip', 'mono-jitsuyou.zip', 'gram-dojg.zip', 'gram-donna.zip',
  'kty-ja-ja.zip', 'JMnedict.zip', 'KANJIDIC_english.zip',
];
// lookup.js gates its single-kanji fallback on the label "KANJIDIC", so that
// name has to survive into the manifest unchanged.
const KNOWN_LABELS = {
  'jitendex-yomitan.zip': 'Jitendex',
  'JMnedict.zip': 'Names',
  'mono-sankoku8.zip': '三省堂',
  'mono-meikyo2.zip': '明鏡',
  'mono-oukoku11.zip': '旺文社',
  'mono-jitsuyou.zip': '実用',
  'gram-dojg.zip': 'DOJG',
  'gram-donna.zip': 'どんなとき',
  'kty-ja-ja.zip': 'Wiktionary',
  'KANJIDIC_english.zip': 'KANJIDIC',
};

// Glossaries live in their own table, deflated, and terms point at them.
//
// Both halves were measured on the full twelve-dictionary set. Every entry is
// indexed under its surface form AND its reading, so storing the glossary on
// the row duplicated it: 1,068 MB of glossary across 2,005,802 rows, of which
// only 463 MB was distinct. Structured content is also repetitive JSON, and
// deflates to about 35% of itself. Verbatim structure cost 1,670 MB against
// the old flattened index's 322 MB, which is not a trade worth making on a
// user's disk.
const SCHEMA = `
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE glosses (id INTEGER PRIMARY KEY, h TEXT UNIQUE, blob BLOB);
  CREATE TABLE terms (key TEXT, reading TEXT, gloss INT, score INT, dict TEXT);
  CREATE TABLE freq  (term TEXT, source TEXT, value INT);
  -- A dict column on every table, so a dictionary can be removed by deleting
  -- its rows instead of rebuilding the whole index. kanji and pitch had no
  -- such column, which is why removing anything used to cost a full rebuild.
  CREATE TABLE kanji (char TEXT PRIMARY KEY, on_yomi TEXT, kun_yomi TEXT,
                      meanings TEXT, dict TEXT);
  CREATE TABLE pitch (term TEXT, reading TEXT, position INT, dict TEXT);
`;

/**
 * What a dictionary is called in the `dict`/`source` columns.
 *
 * Frequency and pitch sources are named by the leading part of their filename
 * rather than by a display label, because their archives carry versions and
 * dates in the name. Removal has to derive the same string the build did, so
 * both go through here.
 */
function freqLabel(file) {
  return file.replace(/\.zip$/i, '').split('_')[0];
}

/** Bank files of a kind, in archive order. */
function banks(z, prefix) {
  return z.names().filter((n) => n.startsWith(prefix)).sort();
}

/**
 * What kind of dictionary an archive is, and what it calls itself.
 *
 * Frequency and pitch banks share a filename prefix; the kind is the second
 * element of each record, so it has to be read rather than inferred.
 */
function classify(zipPath) {
  let z;
  try {
    z = zip.open(zipPath);
  } catch (e) {
    return { kind: null, title: '', error: e.message };
  }
  let title = '';
  // No index.json is not fatal: the banks say what the archive is.
  try {
    title = String(z.readJSON('index.json').title || '').trim();
  } catch { /* no index.json */ }
  // The bank count travels with the kind: it is the only measure of how much
  // work an archive is that can be had before doing the work, and progress
  // reported per ARCHIVE is no progress at all when there is one of them.
  const kanjiBanks = banks(z, 'kanji_bank');
  if (kanjiBanks.length) return { kind: 'kanji', title, banks: kanjiBanks.length, zip: z };
  const termBanks = banks(z, 'term_bank');
  if (termBanks.length) return { kind: 'term', title, banks: termBanks.length, zip: z };
  const metas = banks(z, 'term_meta_bank');
  if (metas.length) {
    // The kind is the second field of each record, and the first few are
    // enough — reading the whole bank to find out cost 900 ms on a frequency
    // list with a million records in it. A prefix is not valid JSON, so this
    // looks for the tag rather than parsing.
    const head = z.readPrefix(metas[0], 64 * 1024).toString('utf8');
    const pitch = head.indexOf('"pitch"');
    const freq = head.indexOf('"freq"');
    const n = metas.length;
    if (pitch >= 0 && (freq < 0 || pitch < freq)) {
      return { kind: 'pitch', title, banks: n, zip: z };
    }
    if (freq >= 0) return { kind: 'freq', title, banks: n, zip: z };
  }
  return { kind: null, title, zip: z };
}

/** Every archive in `dir`, grouped by kind, known ones first and in order. */
function discover(dir) {
  const present = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.zip')).sort()
    : [];
  const ordered = [
    ...KNOWN_ORDER.filter((n) => present.includes(n)),
    ...present.filter((n) => !KNOWN_ORDER.includes(n)),
  ];
  const found = { term: [], kanji: [], pitch: [], freq: [], skipped: [] };
  const labels = new Map();
  const banked = new Map();
  for (const name of ordered) {
    const { kind, title, banks: n, error } = classify(path.join(dir, name));
    if (!kind) {
      found.skipped.push({ name, why: error || 'no recognisable banks' });
      continue;
    }
    labels.set(name, KNOWN_LABELS[name] || title || name.replace(/\.zip$/i, ''));
    banked.set(name, n || 1);
    found[kind].push(name);
  }
  return { ...found, labels, banks: banked };
}

/**
 * Term banks. Stores the glossary field VERBATIM — that is the whole point of
 * this file. Entries are indexed under both surface form and reading so that
 * kana-only text and kanji text both resolve.
 */
function loadTerms(zipPath, db, dict, insert, glossary, onBank = () => {}) {
  const z = zip.open(zipPath);
  let entries = 0;
  for (const bank of banks(z, 'term_bank')) {
    for (const e of z.readJSON(bank)) {
      if (!Array.isArray(e) || e.length < 6) continue;
      const [expr, reading, , , score, gloss] = e;
      const id = glossary.id(JSON.stringify(gloss));
      for (const key of new Set([expr, reading])) {
        if (key) insert.run(String(key), String(reading || ''), id, score || 0, dict);
      }
      entries++;
    }
    onBank();
  }
  return entries;
}

/**
 * Hands out one id per distinct glossary, deflating as it goes.
 *
 * Keyed by digest rather than by the JSON itself: holding a million glossary
 * strings to compare against would cost the 463 MB this exists to avoid. SHA-1
 * over a million items has no realistic collision, and a collision would show
 * as one entry displaying another's senses rather than as corruption.
 */
function glossaryTable(db) {
  const insert = db.prepare('INSERT INTO glosses (h, blob) VALUES (?,?)');
  const seen = new Map();
  let next = 1;
  return {
    id(json) {
      const h = crypto.createHash('sha1').update(json).digest('base64');
      const known = seen.get(h);
      if (known !== undefined) return known;
      const id = next++;
      insert.run(h, zlib.deflateSync(Buffer.from(json, 'utf8'), { level: 6 }));
      seen.set(h, id);
      return id;
    },
    get size() { return seen.size; },
  };
}

/** KANJIDIC banks: [character, onyomi, kunyomi, tags, meanings, stats]. */
function loadKanji(zipPath, db, insert, dict, onBank = () => {}) {
  const z = zip.open(zipPath);
  let n = 0;
  for (const bank of banks(z, 'kanji_bank')) {
    for (const e of z.readJSON(bank)) {
      if (!Array.isArray(e) || e.length < 5 || !e[0]) continue;
      insert.run(String(e[0]), String(e[1] || ''), String(e[2] || ''),
                 JSON.stringify(e[4] || []), dict);
      n++;
    }
    onBank();
  }
  return n;
}

/** NHK banks: [term, "pitch", {reading, pitches:[{position}]}]. */
function loadPitch(zipPath, db, insert, dict, onBank = () => {}) {
  const z = zip.open(zipPath);
  let n = 0;
  for (const bank of banks(z, 'term_meta_bank')) {
    for (const e of z.readJSON(bank)) {
      if (!Array.isArray(e) || e.length < 3 || e[1] !== 'pitch') continue;
      const data = e[2];
      if (!data || typeof data !== 'object') continue;
      for (const p of data.pitches || []) {
        if (Number.isInteger(p.position)) {
          insert.run(String(e[0]), String(data.reading || ''), p.position, dict);
          n++;
        }
      }
    }
    onBank();
  }
  return n;
}

/** Frequency banks. Lowest value wins — these are ranks, not counts. */
function loadFreq(zipPath, onBank = () => {}) {
  const z = zip.open(zipPath);
  const freq = new Map();
  for (const bank of banks(z, 'term_meta_bank')) {
    for (const e of z.readJSON(bank)) {
      if (!Array.isArray(e) || e.length < 3 || e[1] !== 'freq') continue;
      let val = e[2];
      if (val && typeof val === 'object') {
        val = val.value ?? val.frequency;
        if (val && typeof val === 'object') val = val.value;
      }
      if (Number.isInteger(val)) {
        const prev = freq.get(e[0]);
        if (prev === undefined || val < prev) freq.set(e[0], val);
      }
    }
    onBank();
  }
  return freq;
}

/**
 * Build `outPath` from every archive in `dictsDir`.
 *
 * Always a full rebuild rather than a merge: frequency ordering is global, so
 * adding one dictionary changes how senses from the others rank. Imports are
 * rare and a rebuild is minutes; a merge that silently left the ranking stale
 * would be wrong every time after the first.
 */
function build(dictsDir, outPath, onProgress = () => {}) {
  const sources = discover(dictsDir);
  const tmp = outPath + '.building';
  fs.rmSync(tmp, { force: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA);
  const labels = [];
  const counts = {};

  const glossary = glossaryTable(db);
  const insTerm = db.prepare('INSERT INTO terms VALUES (?,?,?,?,?)');
  const insKanji = db.prepare('INSERT INTO kanji VALUES (?,?,?,?,?)');
  const insPitch = db.prepare('INSERT INTO pitch VALUES (?,?,?,?)');
  const insFreq = db.prepare('INSERT INTO freq VALUES (?,?,?)');

  // Bank files, not archives. Progress per archive told the user nothing in
  // the case that matters — installing ONE dictionary, where the only report
  // available is "starting the single thing", which the popup drew as a full
  // bar before any work had happened. A dictionary is many bank files and each
  // is a comparable slice of the work, so they are the unit.
  const banked = sources.banks || new Map();
  const all = [...sources.term, ...sources.kanji, ...sources.pitch, ...sources.freq];
  const total = all.reduce((n, name) => n + (banked.get(name) || 1), 0);
  let done = 0;
  // `done` counts FINISHED banks, so the first report is 0 of n, not 1 of 1.
  const tick = (name) => () => onProgress({ name, done: ++done, total });
  const step = (name) => onProgress({ name, done, total });

  for (const name of sources.term) {
    step(name);
    const label = sources.labels.get(name);
    db.exec('BEGIN');
    counts[name] = loadTerms(path.join(dictsDir, name), db, label, insTerm,
                             glossary, tick(name));
    db.exec('COMMIT');
    if (counts[name]) labels.push(label);
  }
  for (const name of sources.kanji) {
    step(name);
    db.exec('BEGIN');
    counts[name] = loadKanji(path.join(dictsDir, name), db, insKanji,
                             sources.labels.get(name), tick(name));
    db.exec('COMMIT');
    if (counts[name]) labels.push(sources.labels.get(name));
  }
  for (const name of sources.pitch) {
    step(name);
    const label = freqLabel(name);
    db.exec('BEGIN');
    counts[name] = loadPitch(path.join(dictsDir, name), db, insPitch, label,
                             tick(name));
    db.exec('COMMIT');
    // Listed like the rest. A pitch or frequency dictionary does not put
    // senses in the popup, so its position changes nothing — but leaving it
    // out of the manifest left it out of the settings list too, with no way to
    // see it was installed or to take it out again.
    if (counts[name]) labels.push(label);
  }
  for (const name of sources.freq) {
    step(name);
    const freq = loadFreq(path.join(dictsDir, name), tick(name));
    const label = freqLabel(name);
    db.exec('BEGIN');
    for (const [term, value] of freq) insFreq.run(String(term), label, value);
    db.exec('COMMIT');
    counts[name] = freq.size;
    if (freq.size) labels.push(label);
  }

  onProgress({ name: 'building index', done: total, total });
  db.exec('CREATE INDEX idx_terms_key ON terms(key)');
  // Removing a dictionary deletes its terms and then any glossary nothing
  // points at any more. Unindexed that anti-join took 4,192 ms on a 2-million
  // row index; with this it is 1,665 ms, and the index costs 580 ms to build.
  db.exec('CREATE INDEX idx_terms_gloss ON terms(gloss)');
  db.exec('CREATE INDEX idx_freq_term ON freq(term)');
  db.exec('CREATE INDEX idx_pitch_term ON pitch(term)');
  const glosses = glossary.size;
  const rows = db.prepare('SELECT COUNT(*) AS n FROM terms').get().n;
  const keys = db.prepare('SELECT COUNT(DISTINCT key) AS n FROM terms').get().n;
  db.exec('VACUUM');
  db.close();

  // Into place only once it is complete: a half-written index that replaced a
  // working one would break lookups until the next successful import.
  fs.renameSync(tmp, outPath);
  fs.writeFileSync(path.join(path.dirname(outPath), 'dictionaries.json'),
                   JSON.stringify(labels, null, 2) + '\n');
  return { labels, counts, rows, keys, glosses, skipped: sources.skipped };
}

module.exports = { build, discover, classify, freqLabel, KNOWN_LABELS };
