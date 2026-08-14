// The index builder, checked against the archives themselves.
//
// The builder stores glossary structure verbatim, so the property that matters
// is LOSSLESSNESS: what comes out of the database must deep-equal what went
// into it. That is checkable without a second implementation to compare
// against, and it is the property the whole design rests on — the reason a
// dictionary nobody anticipated renders correctly is that nothing was thrown
// away at import.
//
// Everything else is counted directly off the archives: if a term bank holds
// N usable records, the database must hold N entries from it, indexed under
// every key those records name.
//
// Needs data/dicts/. Skips itself when they are absent, because the free ones
// are a download and the commercial ones cannot be shipped — the same reason
// lookup.test.js skips without index.db.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const DICTS = path.join(ROOT, 'data', 'dicts');
const zip = require(path.join(ROOT, 'app/main/zip.js'));
const { build, classify, discover } = require(path.join(ROOT, 'app/main/index-builder.js'));

const available = fs.existsSync(DICTS)
  && fs.readdirSync(DICTS).some((n) => n.endsWith('.zip'));

test('index builder', { skip: available ? false : 'no data/dicts/' }, async (t) => {
  // One small dictionary, so the suite stays quick. DOJG is ~535 records and
  // exercises the plain-string glossary path; KANJIDIC exercises kanji banks.
  const picks = ['gram-dojg.zip', 'KANJIDIC_english.zip']
    .filter((n) => fs.existsSync(path.join(DICTS, n)));
  if (!picks.length) return t.skip('none of the expected sample dictionaries present');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-idx-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  for (const n of picks) fs.copyFileSync(path.join(DICTS, n), path.join(dicts, n));
  const out = path.join(tmp, 'index.db');

  const result = build(dicts, out);
  const db = new DatabaseSync(out, { readOnly: true });
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('writes the database and its manifest', () => {
    assert.ok(fs.existsSync(out), 'index.db exists');
    assert.ok(fs.existsSync(path.join(tmp, 'dictionaries.json')), 'manifest exists');
    assert.ok(result.labels.length > 0, 'at least one dictionary labelled');
  });

  await t.test('leaves no partial file behind', () => {
    assert.ok(!fs.existsSync(out + '.building'), 'temp build file removed');
  });

  await t.test('term glossaries survive the round trip byte for byte', () => {
    const term = picks.find((n) => classify(path.join(dicts, n)).kind === 'term');
    if (!term) return;
    const z = zip.open(path.join(dicts, term));
    const bank = z.names().filter((n) => n.startsWith('term_bank')).sort()[0];
    const records = z.readJSON(bank).filter((e) => Array.isArray(e) && e.length >= 6);
    assert.ok(records.length > 0, 'sample bank has records');

    // Through the join AND the deflate: the round trip now crosses dedupe and
    // compression, so this asserts the storage saving costs no fidelity.
    const q = db.prepare(
      'SELECT g.blob AS blob FROM terms t JOIN glosses g ON g.id = t.gloss'
      + ' WHERE t.key = ? AND t.dict = ?');
    const label = result.labels[0];
    let checked = 0;
    for (const e of records.slice(0, 200)) {
      const [expr, , , , , gloss] = e;
      if (!expr) continue;
      const rows = q.all(String(expr), label);
      assert.ok(rows.length > 0, `entry ${expr} was indexed`);
      // Deep equality, not string equality: JSON key order is preserved by
      // stringify but the assertion should be about the DATA, not its spelling.
      const stored = rows.map((r) =>
        JSON.stringify(JSON.parse(zlib.inflateSync(r.blob).toString('utf8'))));
      assert.ok(stored.includes(JSON.stringify(gloss)),
                `glossary for ${expr} round-tripped unchanged`);
      checked++;
    }
    assert.ok(checked >= 50, `checked a meaningful sample (${checked})`);
  });

  await t.test('every usable record is indexed, under every key it names', () => {
    for (const name of picks) {
      const info = classify(path.join(dicts, name));
      if (info.kind !== 'term') continue;
      const z = zip.open(path.join(dicts, name));
      let expected = 0;
      const keys = new Set();
      for (const b of z.names().filter((n) => n.startsWith('term_bank')).sort()) {
        for (const e of z.readJSON(b)) {
          if (!Array.isArray(e) || e.length < 6) continue;
          expected++;
          for (const k of new Set([e[0], e[1]])) if (k) keys.add(String(k));
        }
      }
      assert.strictEqual(result.counts[name], expected,
                         `${name}: every usable record counted`);
      const label = result.labels[0];
      const distinct = db.prepare(
        'SELECT COUNT(DISTINCT key) AS n FROM terms WHERE dict = ?').get(label).n;
      assert.strictEqual(distinct, keys.size, `${name}: every key indexed`);
    }
  });

  await t.test('kanji entries match the archive', () => {
    const name = picks.find((n) => classify(path.join(dicts, n)).kind === 'kanji');
    if (!name) return;
    const z = zip.open(path.join(dicts, name));
    let expected = 0;
    for (const b of z.names().filter((n) => n.startsWith('kanji_bank')).sort()) {
      for (const e of z.readJSON(b)) {
        if (Array.isArray(e) && e.length >= 5 && e[0]) expected++;
      }
    }
    const got = db.prepare('SELECT COUNT(*) AS n FROM kanji').get().n;
    assert.strictEqual(got, expected, 'every kanji record indexed');
    assert.strictEqual(result.counts[name], expected, 'reported count agrees');
  });

  await t.test('identical glossaries are stored once', () => {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM terms').get().n;
    const distinct = db.prepare('SELECT COUNT(*) AS n FROM glosses').get().n;
    assert.ok(distinct <= rows, 'never more glossaries than rows');
    assert.strictEqual(distinct, result.glosses, 'reported count matches the table');
    const orphans = db.prepare(
      'SELECT COUNT(*) AS n FROM terms WHERE gloss NOT IN (SELECT id FROM glosses)')
      .get().n;
    assert.strictEqual(orphans, 0, 'every term points at a glossary that exists');
  });

  await t.test('the query paths lookup.js depends on are indexed', () => {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all().map((r) => r.name);
    for (const want of ['idx_terms_key', 'idx_freq_term', 'idx_pitch_term']) {
      assert.ok(idx.includes(want), `${want} exists`);
    }
  });

  await t.test('an archive that is not a dictionary is reported, not indexed', () => {
    const junk = path.join(dicts, 'not-a-dictionary.zip');
    fs.writeFileSync(junk, Buffer.from('not a zip at all'));
    const d = discover(dicts);
    assert.ok(d.skipped.some((s) => s.name === 'not-a-dictionary.zip'),
              'reported as skipped');
    assert.ok(!d.term.includes('not-a-dictionary.zip'), 'not treated as a term bank');
    fs.rmSync(junk);
  });
});
