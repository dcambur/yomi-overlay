// The index builder, checked against archives the test makes itself.
//
// The builder stores glossary structure verbatim, so the property that matters
// is LOSSLESSNESS: what comes out of the database must deep-equal what went in.
// That is the reason a dictionary nobody anticipated renders correctly — nothing
// was thrown away at import — and it is checkable without a second
// implementation to compare against.
//
// Fixtures are generated, not borrowed from data/dicts/. The dictionaries worth
// testing against there are commercial, so a suite that reads them cannot run
// for anyone else and quietly skips instead.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const zip = require(path.join(ROOT, 'app/main/zip.js'));
const { build, classify, discover } = require(path.join(ROOT, 'app/main/index-builder.js'));
const mk = require('./fixtures/make-dictionary.js');

test('index builder', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-idx-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  mk.termDictionary(path.join(dicts, 'terms.zip'),
                    { title: 'Terms', entries: 40, banks: 3 });
  mk.kanjiDictionary(path.join(dicts, 'kanji.zip'),
                     { title: 'Kanji', chars: ['一', '二', '三', '四'] });
  mk.pitchDictionary(path.join(dicts, 'pitch_test.zip'), { title: 'Pitch' });
  mk.freqDictionary(path.join(dicts, 'freq_test.zip'), { title: 'Freq' });
  const out = path.join(tmp, 'index.db');

  const result = build(dicts, out);
  const db = new DatabaseSync(out, { readOnly: true });
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('writes the database and its manifest', () => {
    assert.ok(fs.existsSync(out), 'index.db exists');
    assert.ok(fs.existsSync(path.join(tmp, 'dictionaries.json')), 'manifest exists');
    assert.ok(result.labels.includes('Terms'), 'term dictionary labelled');
    assert.ok(result.labels.includes('Kanji'), 'kanji dictionary labelled');
  });

  await t.test('leaves no partial file behind', () => {
    assert.ok(!fs.existsSync(out + '.building'));
  });

  await t.test('glossaries survive the round trip byte for byte', () => {
    const z = zip.open(path.join(dicts, 'terms.zip'));
    const q = db.prepare(
      'SELECT g.blob AS blob FROM terms t JOIN glosses g ON g.id = t.gloss'
      + ' WHERE t.key = ? AND t.dict = ?');
    let checked = 0;
    for (const bank of z.names().filter((n) => n.startsWith('term_bank')).sort()) {
      for (const e of z.readJSON(bank)) {
        const rows = q.all(String(e[0]), 'Terms');
        assert.ok(rows.length > 0, `${e[0]} was indexed`);
        const stored = rows.map((r) =>
          JSON.stringify(JSON.parse(zlib.inflateSync(r.blob).toString('utf8'))));
        assert.ok(stored.includes(JSON.stringify(e[5])),
                  `glossary for ${e[0]} round-tripped unchanged`);
        checked++;
      }
    }
    z.close();
    assert.strictEqual(checked, 40, 'every entry checked');
  });

  await t.test('every entry is indexed under both its forms', () => {
    // Written under expression AND reading, so kana-only text resolves too.
    const n = db.prepare(
      'SELECT COUNT(DISTINCT key) AS n FROM terms WHERE dict = ?').get('Terms').n;
    assert.strictEqual(n, 80, '40 entries, two keys each');
    assert.strictEqual(result.counts['terms.zip'], 40);
  });

  await t.test('a plain-string glossary is stored as written', () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(dir);
    mk.termDictionary(path.join(dir, 'plain.zip'),
                      { title: 'Plain', entries: 3, shape: 'plain' });
    const o = path.join(tmp, 'plain.db');
    build(dir, o);
    const d2 = new DatabaseSync(o, { readOnly: true });
    const row = d2.prepare(
      'SELECT g.blob AS b FROM terms t JOIN glosses g ON g.id = t.gloss LIMIT 1').get();
    const gloss = JSON.parse(zlib.inflateSync(row.b).toString('utf8'));
    d2.close();
    assert.ok(typeof gloss[0] === 'string', 'kept as a string, not wrapped');
    assert.match(gloss[0], /meaning/);
  });

  await t.test('kanji, pitch and frequency all load', () => {
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM kanji').get().n, 4);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM pitch').get().n > 0);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM freq').get().n > 0);
  });

  await t.test('every table records which dictionary a row came from', () => {
    // Without this a dictionary can only be removed by rebuilding the index.
    for (const table of ['terms', 'kanji', 'pitch']) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      assert.ok(cols.includes('dict'), `${table} has dict`);
    }
    assert.ok(db.prepare('PRAGMA table_info(freq)').all()
      .map((c) => c.name).includes('source'), 'freq has source');
  });

  await t.test('identical glossaries are stored once', () => {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM terms').get().n;
    const distinct = db.prepare('SELECT COUNT(*) AS n FROM glosses').get().n;
    assert.ok(distinct < rows, 'deduplicated');
    assert.strictEqual(distinct, result.glosses);
    const orphans = db.prepare(
      'SELECT COUNT(*) AS n FROM terms WHERE gloss NOT IN (SELECT id FROM glosses)').get().n;
    assert.strictEqual(orphans, 0);
  });

  await t.test('the query paths lookup.js depends on are indexed', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all().map((r) => r.name);
    const wanted = ['idx_terms_key', 'idx_terms_gloss', 'idx_freq_term', 'idx_pitch_term'];
    for (const want of wanted) {
      assert.ok(idx.includes(want), `${want} exists`);
    }
  });

  await t.test('a bad CRC is tolerated, because real archives have them', () => {
    const dir = path.join(tmp, 'crc');
    fs.mkdirSync(dir);
    mk.pitchDictionary(path.join(dir, 'nhkish_test.zip'),
                       { title: 'BadCRC', corruptCrc: true });
    const o = path.join(tmp, 'crc.db');
    const r = build(dir, o);
    assert.ok(r.counts['nhkish_test.zip'] > 0, 'indexed despite the checksum');
  });

  await t.test('an archive that is not a dictionary is reported, not indexed', () => {
    const junk = path.join(dicts, 'junk.zip');
    mk.notADictionary(junk);
    const d = discover(dicts);
    assert.ok(d.skipped.some((s) => s.name === 'junk.zip'));
    assert.ok(!d.term.includes('junk.zip'));
    fs.rmSync(junk);
  });

  await t.test('a file that is not a zip at all is reported too', () => {
    const bad = path.join(dicts, 'notazip.zip');
    fs.writeFileSync(bad, 'definitely not a zip');
    assert.strictEqual(classify(bad).kind, null);
    assert.ok(discover(dicts).skipped.some((s) => s.name === 'notazip.zip'));
    fs.rmSync(bad);
  });
});

test('progress starts at nothing and ends at everything', (t) => {
  // The bug this pins: progress was reported per ARCHIVE, and the popup drew
  // "done + 1 of total". Installing one dictionary therefore reported 1/1 —
  // a full bar reading "indexing 100%" — before a single entry was read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-prog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dicts = path.join(dir, 'dicts');
  fs.mkdirSync(dicts);
  mk.termDictionary(path.join(dicts, 'one.zip'),
                    { title: 'One', entries: 12, banks: 4 });

  const seen = [];
  build(dicts, path.join(dir, 'index.db'), (p) => seen.push(p));

  const pct = (p) => Math.round(100 * (p.done || 0) / p.total);
  assert.ok(seen.length > 1, `more than one report (${seen.length})`);
  assert.strictEqual(pct(seen[0]), 0, 'the first report is not "finished"');
  assert.strictEqual(pct(seen.at(-1)), 100, 'the last one is');
  for (let i = 1; i < seen.length; i++) {
    assert.ok(pct(seen[i]) >= pct(seen[i - 1]), 'progress never goes backwards');
  }
  // One dictionary is four banks here: the point of counting banks is that a
  // single dictionary still has intermediate states to show.
  const between = seen.map(pct).filter((n) => n > 0 && n < 100);
  assert.ok(between.length >= 2,
            `a single dictionary still reports partial progress (${seen.map(pct)})`);
});

test('reading an archive does not leave it open', () => {
  // classify() used to hand its zip handle back in the result, where no caller
  // wanted it, so every call leaked an open file. installed() classifies every
  // archive and runs on each settings render: measured at 133 descriptors
  // after twelve calls. A process that runs out of them cannot open a
  // dictionary — or spawn the capture helper.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-fd-'));
  for (const n of ['a', 'b', 'c']) {
    mk.termDictionary(path.join(dir, n + '.zip'), { title: n, entries: 2 });
  }
  const open = () => {
    try {
      return Number(require('child_process')
        .execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`).toString().trim());
    } catch { return 0; }
  };
  const before = open();
  for (let i = 0; i < 20; i++) {
    for (const n of ['a', 'b', 'c']) classify(path.join(dir, n + '.zip'));
  }
  const after = open();
  fs.rmSync(dir, { recursive: true, force: true });
  // 60 classifications. A handle per call would be unmistakable; allow a small
  // margin for whatever else the process opens meanwhile.
  assert.ok(after - before < 10,
            `${after - before} more open files after 60 classifications`);
});

test('a build closes every archive it read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-fd2-'));
  const dicts = path.join(dir, 'dicts');
  fs.mkdirSync(dicts);
  mk.termDictionary(path.join(dicts, 'terms.zip'), { title: 'T', entries: 3 });
  mk.kanjiDictionary(path.join(dicts, 'kanji.zip'), { title: 'K' });
  mk.pitchDictionary(path.join(dicts, 'pitch_p.zip'), { title: 'P' });
  mk.freqDictionary(path.join(dicts, 'freq_f.zip'), { title: 'F' });
  const open = () => {
    try {
      return Number(require('child_process')
        .execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`).toString().trim());
    } catch { return 0; }
  };
  const before = open();
  build(dicts, path.join(dir, 'index.db'));
  const after = open();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(after - before < 8, `${after - before} files left open by one build`);
});
