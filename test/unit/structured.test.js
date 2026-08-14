// Rendering structured content, checked against the thing it replaced.
//
// The old builder flattened each glossary to sense strings when it indexed,
// and did it with per-dictionary knowledge that took real work to get right.
// That text is therefore an oracle: whatever it displayed, the renderer that
// replaced it must still display. If a sense the old index showed is missing
// from the new rendering, the redesign lost something a reader used to see.
//
// Deterministic by construction: a fixed slice of keys in key order, not a
// random sample, so a failure is reproducible and a pass means the same thing
// on every machine.
//
// Needs both shapes — data/index.db from the old builder, and one built here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '../..');
const OLD_DB = path.join(ROOT, 'data', 'index.db');
const DICTS = path.join(ROOT, 'data', 'dicts');

// The module is a browser IIFE hanging itself off window; give it one.
global.window = global.window || {};
require(path.join(ROOT, 'app/renderer/structured.js'));
const { textOf } = global.window.structured;

/**
 * Comparable form: letters and decimal digits only, from BOTH sides.
 *
 * \p{Nd} rather than \p{N} on purpose, so ①②ⓐ go too. The old builder read a
 * sense number out of the node's listStyleType and inlined it as text; the
 * renderer sets it as CSS and lets the browser draw the marker, so it is
 * correctly absent from textContent. Jitendex's Ε and Ω are where that shows.
 *
 * The assertion is that no WORDS were lost, and markers are not words. The old
 * builder synthesised its own sense numbering while flattening; the renderer
 * shows whatever the dictionary itself printed, so the two legitimately differ
 * on ○ in 三省堂 (ⓑ where the dictionary says ⓐ) and on 明鏡's ◆ and → leaders.
 * Stripping punctuation from both sides leaves exactly the claim worth making:
 * every character a reader could read is still there, in order.
 */
const norm = (s) => String(s).replace(/[^\p{L}\p{Nd}]/gu, '');

/**
 * Is every character of `needle` present in `hay`, in order?
 *
 * Subsequence, not substring, because the new rendering legitimately carries
 * MORE than the old one did. The old flattener dropped the bracketed headword
 * 三省堂 prints between a sense number and its text — it stored 「① 円の形」
 * where the dictionary reads 「①［円］円の形」 — so the old text is interleaved
 * inside the new, not contained in it. Requiring order still catches text that
 * genuinely went missing, which is the whole question.
 */
function subsequence(needle, hay) {
  // By code point on BOTH sides. Indexing a string gives UTF-16 code units, so
  // comparing an iterated character against needle[i] never matches anything
  // outside the BMP — 明鏡 defines あいくち with 𠤎 (U+2090E), which is exactly
  // the character that caught this.
  const want = Array.from(needle);
  let i = 0;
  for (const ch of hay) {
    if (ch === want[i]) i++;
    if (i === want.length) return true;
  }
  return want.length === 0;
}

const ready = fs.existsSync(OLD_DB)
  && fs.existsSync(path.join(DICTS, 'gram-dojg.zip'));

test('structured rendering keeps every sense the old index showed', {
  skip: ready ? false : 'needs data/index.db and data/dicts/',
}, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-sc-'));
  const dicts = path.join(tmp, 'dicts');
  fs.mkdirSync(dicts);
  for (const n of fs.readdirSync(DICTS).filter((f) => f.endsWith('.zip'))) {
    fs.copyFileSync(path.join(DICTS, n), path.join(dicts, n));
  }
  const newDb = path.join(tmp, 'index.db');
  require(path.join(ROOT, 'app/main/index-builder.js')).build(dicts, newDb);

  const oldD = new DatabaseSync(OLD_DB, { readOnly: true });
  const newD = new DatabaseSync(newDb, { readOnly: true });
  t.after(() => {
    oldD.close(); newD.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const qOld = oldD.prepare('SELECT gloss, dict FROM terms WHERE key = ?');
  const qNew = newD.prepare(
    'SELECT g.blob AS b, t.dict FROM terms t JOIN glosses g ON g.id = t.gloss'
    + ' WHERE t.key = ?');
  // Fixed slice, in key order: reproducible on any machine with these dicts.
  const keys = oldD.prepare('SELECT DISTINCT key FROM terms ORDER BY key LIMIT 3000')
    .all().map((r) => r.key);

  let senses = 0, covered = 0;
  const missing = [];
  for (const k of keys) {
    const rendered = {};
    for (const r of qNew.all(k)) {
      const g = JSON.parse(zlib.inflateSync(r.b).toString('utf8'));
      rendered[r.dict] = (rendered[r.dict] || '') + norm(textOf(g));
    }
    for (const r of qOld.all(k)) {
      let flat;
      try { flat = JSON.parse(r.gloss); } catch { continue; }
      if (!Array.isArray(flat)) continue;
      const hay = rendered[r.dict];
      if (hay === undefined) continue;      // dictionary absent from this build
      for (const s of flat) {
        const n = norm(s);
        if (Array.from(n).length < 2) continue;
        senses++;
        if (subsequence(n, hay)) covered++;
        else if (missing.length < 5) missing.push(`${k} [${r.dict}] ${s.slice(0, 40)}`);
      }
    }
  }

  await t.test('the comparison actually compared something', () => {
    assert.ok(senses > 1000, `enough senses to mean anything (${senses})`);
  });

  await t.test('no sense the old index displayed was lost', () => {
    assert.deepStrictEqual(missing, [], 'nothing missing');
    assert.strictEqual(covered, senses, `${covered}/${senses} senses preserved`);
  });

  await t.test('ruby readings stay out of the text, as they always did', () => {
    const ruby = { tag: 'ruby', content: ['迷惑', { tag: 'rt', content: 'めいわく' }] };
    assert.strictEqual(textOf(ruby), '迷惑', 'rt is not inlined');
  });

  await t.test('an unrecognised tag keeps its words', () => {
    const odd = { tag: 'marquee', content: [{ tag: 'blink', content: 'still here' }] };
    assert.strictEqual(textOf(odd), 'still here');
  });
});
