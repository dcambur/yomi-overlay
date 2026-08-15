// Serving a dictionary's images out of its own archive.
//
// Nothing is extracted: the handler seeks into the zip and inflates one entry
// (see app/main/media.js for why). That makes three things worth pinning — the
// right bytes come back, a path that is not an entry cannot reach the
// filesystem, and the archives held open to do it stay bounded.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-media-'));
process.env.YOMI_USER_DIR = HOME;

const ROOT = path.resolve(__dirname, '../..');
const mk = require('./fixtures/make-dictionary.js');
const media = require(path.join(ROOT, 'app/main/media.js'));

const DICTS = path.join(HOME, 'dicts');
fs.mkdirSync(DICTS, { recursive: true });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h9v9H0z"/></svg>';
/** A dictionary that ships an image, the way the monolinguals do. */
function withMedia(file, title) {
  mk.writeZip(path.join(DICTS, file), {
    'index.json': JSON.stringify({ title, format: 3, revision: 'test' }),
    'term_bank_1.json': JSON.stringify([['語', 'ご', '', '', 0, ['x'], 0, '']]),
    'icons/一.svg': SVG,
    'icons/big.png': Buffer.alloc(2048, 7),
  });
}
withMedia('a.zip', 'Alpha');
withMedia('b.zip', 'Beta');
withMedia('c.zip', 'Gamma');
withMedia('d.zip', 'Delta');

// The handler asks the dictionaries module where an archive is; this is that
// module's shape, without an index or a config to build first.
const dictionaries = {
  DICTS_DIR: DICTS,
  installed: () => fs.readdirSync(DICTS).filter((f) => f.endsWith('.zip')).map((file) => ({
    file,
    label: { 'a.zip': 'Alpha', 'b.zip': 'Beta',
             'c.zip': 'Gamma', 'd.zip': 'Delta' }[file],
  })),
};

const url = (dict, name) => 'yomi-media://media/' + encodeURIComponent(dict) + '/'
  + name.split('/').map(encodeURIComponent).join('/');

after(() => { media.forget(); fs.rmSync(HOME, { recursive: true, force: true }); });

test('an image comes back as itself', async () => {
  const res = media.serve(url('Alpha', 'icons/一.svg'), dictionaries);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'image/svg+xml');
  assert.strictEqual(await res.text(), SVG, 'byte for byte, out of the archive');
});

test('the content type follows the file, not the dictionary', async () => {
  const res = media.serve(url('Alpha', 'icons/big.png'), dictionaries);
  assert.strictEqual(res.headers.get('content-type'), 'image/png');
  assert.strictEqual((await res.arrayBuffer()).byteLength, 2048);
});

test('a path that is not an entry cannot reach the filesystem', async () => {
  // The path comes from dictionary data, so it is not trusted. It is only ever
  // looked up in the archive's own directory — it never touches a real path —
  // so traversal is not a thing that can happen, and this proves it stays that
  // way.
  const secret = path.join(HOME, 'secret.txt');
  fs.writeFileSync(secret, 'do not serve me');
  for (const name of ['../secret.txt', '../../secret.txt', '/etc/hosts',
                      'icons/../../secret.txt']) {
    const res = media.serve(url('Alpha', name), dictionaries);
    // Refused, by whichever of the two guards gets there first: the URL parser
    // normalises ../ away before the handler sees it, and what survives is
    // looked up in the archive's directory rather than on disk. Both are
    // refusals; which one fires is not the property worth pinning.
    assert.notStrictEqual(res.status, 200, `${name} must not be served`);
    assert.ok(!(await res.text()).includes('do not serve me'),
              `${name} did not reach the filesystem`);
  }
});

test('a dictionary nobody has installed is a 404, not a crash', () => {
  assert.strictEqual(media.serve(url('Nope', 'icons/一.svg'), dictionaries).status, 404);
});

test('a malformed request is refused', () => {
  assert.strictEqual(media.serve('yomi-media://media/', dictionaries).status, 400);
  assert.strictEqual(media.serve('yomi-media://media/OnlyADictionary', dictionaries).status, 400);
});

test('the open archives stay bounded', async () => {
  // Serving images is a handle held open per dictionary. Unbounded, a scroll
  // through a large set ends where the descriptor leak this replaced ended.
  const count = () => {
    try {
      return Number(require('child_process')
        .execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`).toString().trim());
    } catch { return 0; }
  };
  media.forget();
  const before = count();
  for (let i = 0; i < 30; i++) {
    for (const d of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      await media.serve(url(d, 'icons/一.svg'), dictionaries).text();
    }
  }
  const held = count();
  assert.ok(held - before < 8,
            `${held - before} open files after 120 requests across four dictionaries`);
  media.forget();
  assert.ok(count() - before < 4, 'and forget() closes them');
});
