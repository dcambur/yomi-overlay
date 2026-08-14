// Getting dictionaries in: the catalogue, importing a file, removing one.
//
// The download path is checked in two halves. Resolving where a dictionary
// lives needs the network and is therefore its own test that skips when
// offline; everything that decides what lands on disk — validation, naming,
// refusing something that is not a dictionary — is checked without it, because
// that is the part that can quietly corrupt a working setup.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DICTS = path.join(ROOT, 'data', 'dicts');
const SAMPLE = 'gram-donna.zip';

// USER_DIR is `data/` in a checkout, and this suite removes dictionaries and
// rebuilds indexes. Setting $HOME does NOT redirect it — that mistake deleted a
// real dictionary — so aim it explicitly, before the module is loaded.
process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-user-'));
const dictionaries = require(path.join(ROOT, 'app/main/dictionaries.js'));

// Belt and braces: refuse to run at all if anything destructive would land in
// the checkout. An assertion is cheaper than another lost file.
const SCRATCH = process.env.YOMI_USER_DIR;
assert.ok(dictionaries.DICTS_DIR.startsWith(SCRATCH),
          `refusing to run: dictionaries dir is ${dictionaries.DICTS_DIR}`);
assert.ok(!dictionaries.INDEX_PATH.startsWith(ROOT),
          `refusing to run: index path is inside the checkout (${dictionaries.INDEX_PATH})`);

const haveSample = fs.existsSync(path.join(DICTS, SAMPLE));

test('dictionary catalogue', () => {
  const list = dictionaries.catalogue();
  assert.ok(list.length >= 5, 'offers the recommended set');
  for (const c of list) {
    assert.ok(c.id && c.name && c.file, `${c.id} is fully described`);
    assert.strictEqual(typeof c.installed, 'boolean');
    assert.match(c.file, /\.zip$/, 'lands as a zip');
  }
  // These names are how index-builder.js recognises a dictionary and orders it,
  // so renaming one silently changes the popup's sense priority.
  const files = list.map((c) => c.file);
  for (const want of ['jitendex-yomitan.zip', 'JMnedict.zip', 'KANJIDIC_english.zip']) {
    assert.ok(files.includes(want), `${want} is offered under the name the builder expects`);
  }
});

test('importing', { skip: haveSample ? false : 'no sample dictionary' }, async (t) => {
  t.after(() => fs.rmSync(dictionaries.DICTS_DIR, { recursive: true, force: true }));

  await t.test('a real dictionary is accepted and listed', () => {
    const r = dictionaries.importFile(path.join(DICTS, SAMPLE));
    assert.strictEqual(r.file, SAMPLE);
    assert.strictEqual(r.kind, 'term');
    const have = dictionaries.installed();
    assert.strictEqual(have.length, 1);
    assert.strictEqual(have[0].file, SAMPLE);
    assert.ok(have[0].size > 0, 'reports its size');
  });

  await t.test('the catalogue notices what is installed', () => {
    // DOJG is not in the catalogue, so nothing should flip; this asserts the
    // marking is by file name rather than by count.
    assert.ok(dictionaries.catalogue().every((c) => !c.installed));
  });

  await t.test('something that is not a dictionary is refused', () => {
    const junk = path.join(os.tmpdir(), 'junk-' + Date.now() + '.zip');
    fs.writeFileSync(junk, Buffer.from('definitely not a zip'));
    assert.throws(() => dictionaries.importFile(junk), /not a Yomitan dictionary/);
    fs.rmSync(junk);
    assert.strictEqual(dictionaries.installed().length, 1, 'nothing was added');
  });

  await t.test('remove cannot reach outside the dictionaries folder', () => {
    const outside = path.join(os.tmpdir(), 'outside-' + Date.now() + '.zip');
    fs.writeFileSync(outside, 'x');
    assert.throws(() => dictionaries.remove('../../' + path.basename(outside)),
                  /no such dictionary/);
    assert.ok(fs.existsSync(outside), 'the file outside is untouched');
    fs.rmSync(outside);
  });

  await t.test('the same dictionary imported twice stays one dictionary', () => {
    // Under the same name it simply overwrites. Under a DIFFERENT name it used
    // to install alongside itself: two archives, two labels in the popup, and
    // every sense shown twice.
    const copy = path.join(os.tmpdir(), 'copy-' + Date.now() + '.zip');
    fs.copyFileSync(path.join(DICTS, SAMPLE), copy);
    const r = dictionaries.importFile(copy);
    assert.deepStrictEqual(r.replaced, [SAMPLE], 'replaced the copy already here');
    const have = dictionaries.installed();
    assert.strictEqual(have.length, 1, 'still one archive');
    assert.strictEqual(have[0].file, path.basename(copy), 'the newer import won');
    fs.rmSync(copy);

    // Put it back under its usual name for the tests that follow.
    dictionaries.importFile(path.join(DICTS, SAMPLE));
    assert.strictEqual(dictionaries.installed().length, 1);
  });

  await t.test('a dictionary with no title of its own is left alone', () => {
    // dropDuplicates matches on the archive's own name; with nothing to match
    // on it must not delete something at random.
    const before = dictionaries.installed().map((d) => d.file);
    assert.deepStrictEqual(dictionaries.dropDuplicates('', 'whatever.zip'), []);
    assert.deepStrictEqual(dictionaries.installed().map((d) => d.file), before);
  });

  await t.test('remove takes it out again', () => {
    for (const d of dictionaries.installed()) dictionaries.remove(d.file);
    assert.strictEqual(dictionaries.installed().length, 0);
  });

  await t.test('rebuilding with nothing installed clears the index', () => {
    const r = dictionaries.rebuild();
    assert.deepStrictEqual(r.labels, []);
    assert.ok(!fs.existsSync(dictionaries.INDEX_PATH), 'no index left behind');
  });

  await t.test('rebuilding indexes what was imported', () => {
    dictionaries.importFile(path.join(DICTS, SAMPLE));
    const r = dictionaries.rebuild();
    assert.ok(r.labels.includes('どんなとき'), 'labelled by the builder');
    assert.ok(r.rows > 0 && r.keys > 0, 'has content');
    assert.ok(fs.existsSync(dictionaries.INDEX_PATH), 'index written');
  });
});
