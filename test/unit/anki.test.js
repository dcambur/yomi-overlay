// The AnkiConnect client and the Lapis note it builds (app/main/anki.js).
//
// The note builder is checked against words whose furigana is known — the
// language is the ground truth, not the builder. The client is run against a
// local HTTP double that answers the way AnkiConnect's plugin/__init__.py
// does (same actions, same error strings), because what it has to get right
// is the protocol: version 6 on every call, `multi` unwrapped, a duplicate
// answered with the note that exists, a picture read off disk and removed.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
process.env.YOMI_USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-anki-'));
const {
  createAnki, lapisFields, furiganaPlain, harmonicRank, searchValue, MODEL, NO_FREQUENCY,
} = require(path.join(ROOT, 'app', 'main', 'anki.js'));

// --- the note builder ---------------------------------------------------------

test('bracket furigana: kanji runs take the reading, kana stays, a space before each', () => {
  assert.strictEqual(furiganaPlain('食べる', 'たべる'), '食[た]べる');
  assert.strictEqual(furiganaPlain('信じ切る', 'しんじきる'), '信[しん]じ 切[き]る');
  assert.strictEqual(furiganaPlain('小遣い稼ぎ', 'こづかいかせぎ'), '小遣[こづか]い 稼[かせ]ぎ');
  assert.strictEqual(furiganaPlain('生き生き', 'いきいき'), '生[い]き 生[い]き');
  assert.strictEqual(furiganaPlain('十中八九', 'じっちゅうはっく'), '十中八九[じっちゅうはっく]');
  assert.strictEqual(furiganaPlain('立ちこめる', 'たちこめる'), '立[た]ちこめる');
});

test('a kana word has no furigana; katakana in the term still matches the reading', () => {
  assert.strictEqual(furiganaPlain('さらう', 'さらう'), '');
  assert.strictEqual(furiganaPlain('ニャーニャー', 'にゃーにゃー'), '');
  assert.strictEqual(furiganaPlain('猫カフェ', 'ねこかふぇ'), '猫[ねこ]カフェ');
});

test('a reading the term cannot be aligned with is still a correct card', () => {
  // The kana in the term is not in the reading where it should be: fall
  // back to the whole word rather than mis-assign.
  assert.strictEqual(furiganaPlain('大人', 'おとな'), '大人[おとな]');
  assert.strictEqual(furiganaPlain('今日は', 'こんにちは'), '今日[こんにち]は');
  assert.strictEqual(furiganaPlain('行く', 'いった'), '行く[いった]');
  assert.strictEqual(furiganaPlain('日本語', ''), '');
});

test('the harmonic rank is the floor of the harmonic mean, or the no-frequency rank', () => {
  assert.strictEqual(harmonicRank([100, 300]), 150);
  assert.strictEqual(harmonicRank([29837]), 29837);
  assert.strictEqual(harmonicRank([10, 1000]), Math.floor(2 / (1 / 10 + 1 / 1000)));
  assert.strictEqual(harmonicRank([]), NO_FREQUENCY);
  assert.strictEqual(harmonicRank([0, -1, NaN]), NO_FREQUENCY);
});

test('a search value escapes what Anki would read as syntax', () => {
  assert.strictEqual(searchValue('a_b*c'), 'a\\_b\\*c');
  assert.strictEqual(searchValue('say "hi"'), 'say \\"hi\\"');
  assert.strictEqual(searchValue('-x:y(z)\\'), '\\-x\\:y\\(z\\)\\\\');
  assert.strictEqual(searchValue('牽引'), '牽引');
});

test('the Lapis fields, from what the popup knows', () => {
  const f = lapisFields({
    expression: '牽引', reading: 'けんいん',
    sentence: 'トラックを<b>牽引</b>してもらう', glossary: '<div>g</div>',
    mainDefinition: '', pitch: [0], freq: [{ source: 'JPDB', value: 29837 }],
  });
  assert.deepStrictEqual(f, {
    Expression: '牽引',
    ExpressionFurigana: '牽引[けんいん]',
    ExpressionReading: 'けんいん',
    MainDefinition: '',
    Sentence: 'トラックを<b>牽引</b>してもらう',
    Glossary: '<div>g</div>',
    IsWordAndSentenceCard: '1',
    PitchPosition: '[0]',
    Frequency: '<ul style="text-align: left;"><li>JPDB: 29837</li></ul>',
    FreqSort: '29837',
  });
});

test('no frequency, no pitch: the fields say so the way Lapis expects', () => {
  const f = lapisFields({ expression: '一山幾ら', reading: 'ひとやまいくら' });
  assert.strictEqual(f.Frequency, '');
  assert.strictEqual(f.FreqSort, String(NO_FREQUENCY));
  assert.strictEqual(f.PitchPosition, '');
  assert.strictEqual(f.Sentence, '');
});

test('several accents are several brackets; a list name is escaped', () => {
  const f = lapisFields({
    expression: '雨', reading: 'あめ', pitch: [1, 0],
    freq: [{ source: 'A&B', value: 5 }, { source: 'C', value: 15 }],
  });
  assert.strictEqual(f.PitchPosition, '[1] [0]');
  assert.strictEqual(f.Frequency,
                     '<ul style="text-align: left;"><li>A&amp;B: 5</li><li>C: 15</li></ul>');
  assert.strictEqual(f.FreqSort, String(Math.floor(2 / (1 / 5 + 1 / 15))));
});

// --- the client, against an AnkiConnect double ---------------------------------

/** What plugin/__init__.py answers, for the actions the client uses. */
function ankiDouble() {
  const notes = new Map();   // id -> {deck, fields, tags, picture}
  let nextId = 1000;
  const log = [];
  const one = (req) => {
    log.push(req);
    const p = req.params || {};
    if (req.version !== 6) throw new Error('version 6 expected on every action');
    switch (req.action) {
      case 'version': return 6;
      case 'modelNames': return ['Basic', MODEL];
      case 'deckNames': return ['Default', 'Mining', 'Mining::Novels'];
      case 'findNotes': {
        const m = /^"deck:(.+?)" "note:Lapis" "expression:(.+)"$/.exec(p.query);
        if (!m) throw new Error('query shape: ' + p.query);
        const unescape = (s) => s.replace(/\\(.)/g, '$1');
        const deck = unescape(m[1]), expr = unescape(m[2]);
        return [...notes].filter(([, n]) => n.deck === deck && n.fields.Expression === expr)
          .map(([id]) => id);
      }
      case 'addNote': {
        const n = p.note;
        if (n.modelName !== MODEL) throw new Error(`model was not found: ${n.modelName}`);
        if (!['Default', 'Mining', 'Mining::Novels'].includes(n.deckName)) {
          throw new Error(`deck was not found: ${n.deckName}`);
        }
        if (!n.fields.Expression) throw new Error('cannot create note because it is empty');
        const dup = [...notes.values()].some((x) =>
          x.deck === n.deckName && x.fields.Expression === n.fields.Expression);
        if (dup && !n.options.allowDuplicate) {
          throw new Error('cannot create note because it is a duplicate');
        }
        const picture = (n.picture || []).map((pic) => ({
          filename: pic.filename, fields: pic.fields, bytes: fs.readFileSync(pic.path),
        }));
        const id = ++nextId;
        notes.set(id, { deck: n.deckName, fields: n.fields, tags: n.tags, picture });
        return id;
      }
      case 'deleteNotes':
        for (const id of p.notes) notes.delete(id);
        return null;
      case 'multi':
        return p.actions.map((a) => {
          try { return { result: one(a), error: null }; }
          catch (e) { return { result: null, error: e.message }; }
        });
      default: throw new Error('unsupported action');
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let out;
      try { out = { result: one(JSON.parse(body)), error: null }; }
      catch (e) { out = { result: null, error: e.message }; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { server, notes, log };
}

const double = ankiDouble();
let url;
const settings = {
  enabled: true, deck: 'Mining', tags: ['yomi-overlay', 'test'], picture: false, key: null,
};
const cfg = { anki: () => ({ ...settings, url }) };

before(async () => {
  await new Promise((r) => double.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${double.server.address().port}`;
});
after(() => double.server.close());

test('status: running, has Lapis, lists decks', async () => {
  const anki = createAnki({ cfg });
  const s = await anki.status();
  assert.deepStrictEqual(s, {
    enabled: true, deck: 'Mining', running: true, version: 6, model: true,
    decks: ['Default', 'Mining', 'Mining::Novels'],
  });
});

test('add, find, refuse the duplicate with the note that exists, remove', async () => {
  const anki = createAnki({ cfg });
  assert.deepStrictEqual(await anki.find(['牽引']), { ok: true, ids: [null] });

  const added = await anki.add({ expression: '牽引', reading: 'けんいん', sentence: 'x' });
  assert.strictEqual(added.ok, true);
  const note = double.notes.get(added.noteId);
  assert.strictEqual(note.deck, 'Mining');
  assert.deepStrictEqual(note.tags, ['yomi-overlay', 'test']);
  assert.strictEqual(note.fields.ExpressionFurigana, '牽引[けんいん]');
  assert.strictEqual(note.fields.IsWordAndSentenceCard, '1');

  assert.deepStrictEqual(await anki.find(['牽引', '猫']), { ok: true, ids: [added.noteId, null] });

  const again = await anki.add({ expression: '牽引', reading: 'けんいん' });
  assert.deepStrictEqual(again, { ok: true, noteId: added.noteId, existed: true });
  assert.strictEqual(double.notes.size, 1, 'nothing was added the second time');

  assert.deepStrictEqual(await anki.remove(added.noteId), { ok: true });
  assert.deepStrictEqual(await anki.find(['牽引']), { ok: true, ids: [null] });
});

test('the deck is part of the search, so the same word in another deck is new', async () => {
  const anki = createAnki({ cfg });
  const a = await anki.add({ expression: '猫', reading: 'ねこ' });
  settings.deck = 'Mining::Novels';
  try {
    assert.deepStrictEqual(await anki.find(['猫']), { ok: true, ids: [null] });
    const b = await anki.add({ expression: '猫', reading: 'ねこ' });
    assert.notStrictEqual(b.noteId, a.noteId);
    await anki.remove(b.noteId);
  } finally {
    settings.deck = 'Mining';
    await anki.remove(a.noteId);
  }
});

test('a picture is asked from the crop channel, read by Anki, and cleaned up', async () => {
  let asked = null;
  const requestCrop = async (rect, file) => {
    asked = { rect, file };
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return true;
  };
  settings.picture = true;
  const anki = createAnki({ cfg, requestCrop });
  try {
    const region = { x: 1, y: 2, w: 30, h: 40 };
    const r = await anki.add({ expression: '絵', reading: 'え', region });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(asked.rect, { x: 1, y: 2, w: 30, h: 40 });
    const note = double.notes.get(r.noteId);
    assert.strictEqual(note.picture.length, 1);
    assert.deepStrictEqual(note.picture[0].fields, ['Picture']);
    assert.match(note.picture[0].filename, /^yomi-overlay-\d{14}-\d+\.png$/);
    assert.strictEqual(note.picture[0].bytes.length, 4, 'Anki read the file');
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(!fs.existsSync(asked.file), 'the temp file is gone once Anki has it');
    await anki.remove(r.noteId);
  } finally {
    settings.picture = false;
  }
});

test('two adds in the same second get two files and two media names', async () => {
  const files = [];
  const requestCrop = async (_rect, file) => {
    files.push(file);
    fs.writeFileSync(file, Buffer.from([files.length]));
    return true;
  };
  settings.picture = true;
  const anki = createAnki({ cfg, requestCrop });
  try {
    const region = { x: 0, y: 0, w: 1, h: 1 };
    const [a, b] = await Promise.all([
      anki.add({ expression: '甲', reading: 'こう', region }),
      anki.add({ expression: '乙', reading: 'おつ', region }),
    ]);
    assert.notStrictEqual(files[0], files[1], 'two temp files');
    const pa = double.notes.get(a.noteId).picture[0];
    const pb = double.notes.get(b.noteId).picture[0];
    assert.notStrictEqual(pa.filename, pb.filename, 'two media names');
    assert.strictEqual(pa.bytes[0], 1, 'the first card got the first crop');
    assert.strictEqual(pb.bytes[0], 2, 'the second card got the second crop');
    await anki.remove(a.noteId);
    await anki.remove(b.noteId);
  } finally {
    settings.picture = false;
  }
});

test('no crop, no picture, still a card', async () => {
  settings.picture = true;
  const anki = createAnki({ cfg, requestCrop: async () => false });
  try {
    const region = { x: 0, y: 0, w: 1, h: 1 };
    const r = await anki.add({ expression: '無', reading: 'む', region });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(double.notes.get(r.noteId).picture, []);
    await anki.remove(r.noteId);
  } finally {
    settings.picture = false;
  }
});

test('off, or no deck: refused before Anki is asked', async () => {
  const anki = createAnki({ cfg });
  const sent = double.log.length;
  settings.enabled = false;
  assert.match((await anki.find(['x'])).error, /off in Settings/);
  settings.enabled = true;
  settings.deck = null;
  assert.match((await anki.add({ expression: 'x' })).error, /no deck/);
  settings.deck = 'Mining';
  assert.strictEqual(double.log.length, sent, 'no request went out');
});

test('a missing note type is named as the thing to fix', async () => {
  const anki = createAnki({ cfg });
  settings.deck = 'Nope';
  const r = await anki.add({ expression: 'x', reading: 'x' });
  settings.deck = 'Mining';
  assert.match(r.error, /deck "Nope" is not in Anki/);
});

test('Anki not running: status says so, nothing throws', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const anki = createAnki({ cfg: { anki: () => ({ ...settings, url: `http://127.0.0.1:${port}` }) } });
  const s = await anki.status();
  assert.strictEqual(s.running, false);
  assert.match(s.error, /Anki is not running/);
  assert.match((await anki.find(['x'])).error, /not running/);
  assert.match((await anki.add({ expression: 'x' })).error, /not running/);
});

test('an API key rides along on every action, sub-actions included', async () => {
  settings.key = 'secret';
  const anki = createAnki({ cfg });
  try {
    const at = double.log.length;
    await anki.status();
    const multi = double.log[at];
    assert.strictEqual(multi.key, 'secret');
    for (const a of multi.params.actions) assert.strictEqual(a.key, 'secret');
  } finally {
    settings.key = null;
  }
});
