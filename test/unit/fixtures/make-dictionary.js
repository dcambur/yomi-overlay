// Build a Yomitan dictionary archive, so the tests do not need a real one.
//
// The suites used to read whatever was in data/dicts/. That is unrunnable for
// anyone else: the interesting dictionaries there are commercial, cannot be
// redistributed, and are absent on a runner and in a fresh clone — so the tests
// quietly skipped, and "all green" meant nothing. Worse, it made keeping
// copyrighted files around a precondition for contributing.
//
// A Yomitan archive is an index.json and some numbered bank files in a zip, so
// the tests can make their own. Synthetic fixtures are also the only way to
// exercise the cases no real dictionary provides: a bad CRC, an unknown bank,
// two archives that claim the same title.
//
// The writer is here rather than beside app/main/zip.js because nothing the app
// does needs to WRITE a zip; only the tests do.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** CRC-32, because a zip entry carries one and some readers check it. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Write `files` (name -> Buffer|string) as a zip at `dest`.
 *
 * `corruptCrc` deliberately stores the wrong checksum: some redistributed
 * dictionaries do exactly that while containing valid JSON, and the reader is
 * required to tolerate it.
 */
function writeZip(dest, files, { corruptCrc = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = corruptCrc ? 0xdeadbeef : crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([...locals, cdBuf, eocd]));
  return dest;
}

/**
 * The glossary shapes a Yomitan dictionary can carry.
 *
 * Not invented: these are the four the old Python flattener has separate code
 * paths for (build-index.py `flatten_glossary`), and each was written against
 * real dictionaries — `jmdict` against Jitendex/JMdict, `mono` against
 * 三省堂-style monolinguals, `plain` against 明鏡・旺文社・実用・DOJG,
 * `sc` against anything else with a structure. Generating all four is how the
 * tests cover shapes that no ONE dictionary provides, and the reason they no
 * longer need a shelf of commercial archives to say anything.
 */
const SHAPES = {
  /** JMdict/Jitendex: a sense node whose number is CSS, holding glossary li. */
  jmdict: (n) => [{
    type: 'structured-content',
    content: [
      { tag: 'div', data: { content: 'part-of-speech-info' }, content: 'noun' },
      { tag: 'ol', data: { content: 'sense' }, style: { listStyleType: '"①"' },
        content: { tag: 'ul', data: { content: 'glossary' },
                   content: [{ tag: 'li', content: `meaning ${n}` },
                             { tag: 'li', content: `sense ${n}` }] } },
      { tag: 'div', data: { content: 'attribution' }, content: 'from nowhere' },
    ],
  }],
  /** 三省堂-style: a 語義 block with a numbered 語義番号 and a 語釈 body. */
  mono: (n) => [{
    type: 'structured-content',
    content: [
      { tag: 'div', data: { name: '見出部' }, content: `語${n}` },
      { tag: 'div', data: { name: '語義' }, content: [
        { tag: 'span', data: { name: '語義番号' }, content: '①' },
        { tag: 'span', data: { name: '語釈' }, content: `定義${n}である` },
        { tag: 'span', data: { name: '用例G' }, content: `「用例${n}」` },
      ] },
    ],
  }],
  /** One newline-formatted string, headword line first. */
  plain: (n) => [`語${n}【語${n}】\n① meaning ${n}\n「example ${n}」`],
  /** Structure with no marker the flattener recognises. */
  sc: (n) => [{
    type: 'structured-content',
    content: [
      { tag: 'div', style: { listStyleType: '"①"' },
        content: [{ tag: 'span', content: `meaning ${n}` }] },
      { tag: 'ruby', content: [`語${n}`, { tag: 'rt', content: `ご${n}` }] },
    ],
  }],
};

/**
 * A term dictionary.
 *
 * `shape` picks the glossary form (see SHAPES). The index stores each one
 * differently and the old flattener read each one differently, so a suite that
 * means to cover the format covers all four.
 *
 * `words` gives real headwords as [expression, reading] pairs, for the tests
 * that need a particular word rather than a particular quantity — deinflection
 * has to be checked on something that actually conjugates. Without it the
 * entries are numbered filler, which is all a bulk test needs.
 */
function termDictionary(dest, {
  title = 'Test Dictionary', entries = 20, shape = 'sc', banks = 1,
  words = null, corruptCrc = false,
} = {}) {
  const glossFor = SHAPES[shape];
  if (!glossFor) throw new Error(`unknown glossary shape: ${shape}`);
  const heads = words || Array.from({ length: entries },
                                    (_, n) => [`語${n}`, `ご${n}`]);
  const files = { 'index.json': JSON.stringify({ title, format: 3, revision: 'test' }) };
  const perBank = Math.ceil(heads.length / banks);
  let made = 0;
  for (let b = 1; b <= banks; b++) {
    const bank = [];
    for (let i = 0; made < heads.length && i < perBank; i++, made++) {
      const [expr, reading] = heads[made];
      // [expression, reading, defTags, rules, score, glossary, sequence, termTags]
      bank.push([expr, reading, '', '', 100 - made, glossFor(made), made, '']);
    }
    files[`term_bank_${b}.json`] = JSON.stringify(bank);
  }
  return writeZip(dest, files, { corruptCrc });
}

/** A kanji dictionary: [character, onyomi, kunyomi, tags, meanings, stats]. */
function kanjiDictionary(dest, { title = 'Test Kanji', chars = ['一', '二', '三'] } = {}) {
  return writeZip(dest, {
    'index.json': JSON.stringify({ title, format: 3, revision: 'test' }),
    'kanji_bank_1.json': JSON.stringify(
      chars.map((c, i) => [c, `オン${i}`, `くん${i}`, '', [`meaning ${i}`], {}])),
  });
}

/** A frequency list: [term, "freq", value]. */
function freqDictionary(dest, { title = 'Test Freq', entries = 30 } = {}) {
  const bank = [];
  for (let i = 0; i < entries; i++) bank.push([`語${i}`, 'freq', i + 1]);
  return writeZip(dest, {
    'index.json': JSON.stringify({ title, format: 3, revision: 'test' }),
    'term_meta_bank_1.json': JSON.stringify(bank),
  });
}

/** A pitch-accent dictionary: [term, "pitch", {reading, pitches}]. */
function pitchDictionary(dest, { title = 'Test Pitch', entries = 10, corruptCrc = false } = {}) {
  const bank = [];
  for (let i = 0; i < entries; i++) {
    bank.push([`語${i}`, 'pitch', { reading: `ご${i}`, pitches: [{ position: i % 4 }] }]);
  }
  return writeZip(dest, {
    'index.json': JSON.stringify({ title, format: 3, revision: 'test' }),
    'term_meta_bank_1.json': JSON.stringify(bank),
  }, { corruptCrc });
}

/** A zip that is not a dictionary at all. */
function notADictionary(dest) {
  return writeZip(dest, { 'readme.txt': 'nothing to see here' });
}

module.exports = {
  SHAPES, writeZip, termDictionary, kanjiDictionary, freqDictionary, pitchDictionary,
  notADictionary, crc32,
};
