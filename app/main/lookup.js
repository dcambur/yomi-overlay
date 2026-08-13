// Dictionary lookup against the prebuilt SQLite index, using Yomitan's own
// deinflection engine (ext/js/language/ja/japanese-transforms.js) rather than a
// hand-rolled rule table — chained, condition-typed transforms, so
// 信じられている resolves to 信じる and 愛された to 愛する.
//
// Runs in the main process: node:sqlite is synchronous and the index is large,
// so keeping it out of the renderer avoids janking the overlay on every hover.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const { DATA_DIR } = require('../paths.js');
const DB_PATH = path.join(DATA_DIR, 'index.db');
const cfg = require('./config.js');

let db = null;
let qTerm, qKanji, qPitch, qFreq;
let transformer = null;

// Display order and visibility both come from settings, so the popup reflects
// whatever the user arranged without a rebuild.
// Read once per lookup, not once per comparison: rank() runs inside a sort
// comparator, and re-deriving the list there is O(n log n) config reads.
let orderCache = null;
function refreshOrder() {
  const list = cfg.enabledDictionaries();
  orderCache = { list, index: new Map(list.map((n, i) => [n, i])) };
  return orderCache;
}
function rank(d) {
  const o = orderCache || refreshOrder();
  const i = o.index.get(d);
  return i === undefined ? o.list.length : i;
}
function visible(d) {
  return (orderCache || refreshOrder()).index.has(d);
}

function open() {
  if (db) return true;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    // No LIMIT here. A SQL limit is applied before the visibility filter and
    // before ranking, so it silently starves whole dictionaries: 「こう」has 313
    // rows and the first 40 are all Jitendex, which meant disabling Jitendex
    // returned nothing at all and reordering dictionaries had no effect.
    // The widest key in the index is 313 rows — cheap to filter in JS instead.
    qTerm = db.prepare(
      'SELECT reading, gloss, dict, score FROM terms WHERE key = ?');
    qKanji = db.prepare('SELECT on_yomi, kun_yomi, meanings FROM kanji WHERE char = ?');
    qPitch = db.prepare('SELECT reading, position FROM pitch WHERE term = ? LIMIT 4');
    qFreq = db.prepare('SELECT source, value FROM freq WHERE term = ?');
    return true;
  } catch (e) {
    console.error('lookup: cannot open index.db —', e.message);
    console.error('run: python3 build-index.py');
    return false;
  }
}

/** Yomitan's transformer is ESM; load it once, asynchronously. */
async function initTransformer() {
  if (transformer) return transformer;
  const { LanguageTransformer } = await import('../vendor/yomitan/language-transformer.js');
  const { japaneseTransforms } = await import('../vendor/yomitan/japanese-transforms.js');
  const lt = new LanguageTransformer();
  lt.addDescriptor(japaneseTransforms);
  transformer = lt;
  return lt;
}

/**
 * Candidate dictionary forms for a surface string, best-effort ordered:
 * the surface itself first, then Yomitan's derived forms.
 */
function deinflect(surface) {
  if (!transformer) return [surface];
  const seen = new Set();
  const out = [];
  for (const r of transformer.transform(surface)) {
    if (seen.has(r.text)) continue;
    seen.add(r.text);
    out.push({ text: r.text, steps: r.trace ? r.trace.length : 0 });
  }
  // Fewest transformations first — the least tortured reading is usually right.
  out.sort((a, b) => a.steps - b.steps);
  return out.map(o => o.text);
}

/**
 * Rows for one dictionary-form candidate -> displayable entries, ordered.
 * Returns null when nothing visible survives the filters.
 */
function buildEntries(rows, hint) {
  const seen = new Set();
  const entries = [];
  let score = -Infinity;
  for (const r of rows) {
    if (!visible(r.dict)) continue;      // hidden in settings
    const key = r.dict + '|' + r.reading + '|' + r.gloss;
    if (seen.has(key)) continue;
    seen.add(key);
    let g;
    try { g = JSON.parse(r.gloss); } catch { g = [r.gloss]; }
    // Drop entries that are just a reading fragment with no real content.
    if (g.length === 1 && g[0].length <= 2 && g[0] === r.reading) continue;
    entries.push({ reading: r.reading, dict: r.dict, glosses: g });
    if (typeof r.score === 'number') score = Math.max(score, r.score);
  }
  if (!entries.length) return null;

  entries.sort((a, b) => rank(a.dict) - rank(b.dict));

  // Furigana hint (Phase 4): the page itself printed this word's reading
  // beside it. Prefer entries whose reading it contains — the ruby beside
  // 生 decides between なま and せい at zero inference cost. Stable sort,
  // so dictionary rank still breaks ties. Substring containment is a
  // heuristic (the hint concatenates the whole line's ruby); short kana
  // may false-positive, which only reorders, never removes.
  if (hint) {
    entries.sort((a, b) =>
      (hint.includes(b.reading) ? 1 : 0) - (hint.includes(a.reading) ? 1 : 0));
  }

  // Give every enabled dictionary a shot at the first visible screenful.
  // Ranking alone lets the top one monopolise it — 「こう」has 54 Jitendex
  // senses, so a reader who also enabled 三省堂 would scroll a long way
  // before the first monolingual gloss.
  const perDict = new Map();
  const first = [], rest = [];
  for (const e of entries) {
    const n = (perDict.get(e.dict) || 0) + 1;
    perDict.set(e.dict, n);
    (n <= 2 ? first : rest).push(e);
  }
  return { entries: first.concat(rest), score: score === -Infinity ? 0 : score };
}

/**
 * Multi-length lookup, Yomitan's shape: every prefix of the scanned text is
 * deinflected and looked up, and every hit becomes a headword group — so
 * 転生してきた shows 転生 first AND the 転/てん entries after it, exactly
 * like Yomitan's popup. Group order follows Yomitan's comparator chain
 * (translator.js _sortTermDictionaryEntries — reimplemented, not ported):
 * source-text length desc -> fewest deinflection steps -> frequency ->
 * term score desc. Deviation: Yomitan ranks a primary-reading match above
 * everything, but our furigana hint is line-level rather than word-level,
 * so it stays an entry-level tiebreak — a coarse hint must not outrank the
 * longest match.
 *
 * Pass an array of per-glyph strings — one entry per span in the overlay's
 * layer. `matchLength` then comes back counted in glyphs, so the caller can
 * highlight exactly that many spans. A joined string cannot do this: JS slices
 * by UTF-16 code unit, so a non-BMP kanji (𠮟, 𩸽) would both split mid-surrogate
 * and report a length two units long for one span. A plain string is still
 * accepted for callers that don't care.
 */
function lookup(input, maxLen = 12, hint = null) {
  if (!open() || !input || !input.length) return null;
  refreshOrder();          // pick up settings changes without a restart

  const glyphs = Array.isArray(input) ? input : Array.from(input);
  const limit = Math.min(maxLen, glyphs.length);

  const groups = [];
  const seenTerm = new Set();   // dictionary form -> keep longest-source hit
  for (let len = limit; len >= 1; len--) {
    // NFKC before the query: OCR reads codepoint "twins" (full-width ！？,
    // half-width ｶﾅ, CJK radical variants like U+2F08 for 人) that render
    // identically but miss the index. matchLength stays counted in SOURCE
    // glyphs, so highlighting is unaffected even when NFKC merges ｶ+ﾞ.
    const surface = glyphs.slice(0, len).join('').normalize('NFKC');

    const cands = deinflect(surface);
    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci];
      if (seenTerm.has(cand)) continue;   // found via a longer source already
      const rows = qTerm.all(cand);
      if (!rows.length) continue;
      const built = buildEntries(rows, hint);
      if (!built) continue;
      seenTerm.add(cand);

      const pitch = qPitch.all(cand).map(p => ({ reading: p.reading, position: p.position }));
      const freq = qFreq.all(cand).map(f => ({ source: f.source, value: f.value }));
      freq.sort((a, b) => a.value - b.value);

      groups.push({
        surface,
        base: cand !== surface ? cand : null,
        // Counted in glyphs, so the caller can highlight exactly this many spans.
        matchLength: len,
        entries: built.entries,
        pitch,
        freq,
        // deinflect() orders candidates fewest-transformations-first, so the
        // ordinal stands in for Yomitan's inflection-chain-length tiebreak.
        steps: ci,
        score: built.score,
        minFreq: freq.length ? freq[0].value : Infinity,
      });
    }
  }

  if (groups.length) {
    groups.sort((a, b) =>
      b.matchLength - a.matchLength ||
      a.steps - b.steps ||
      a.minFreq - b.minFreq ||
      b.score - a.score);
    // Primary fields stay at the top level so the highlight and tier-2 paths
    // keep reading the same shape as before; groups carries the full list.
    return { ...groups[0], groups };
  }

  // No word matched — fall back to the single kanji. Index the glyph array, not
  // the raw string: text[0] would hand a lone surrogate half to the query.
  const ch = glyphs[0].normalize('NFKC');
  const k = visible('KANJIDIC') ? qKanji.get(ch) : null;
  if (k) {
    let meanings;
    try { meanings = JSON.parse(k.meanings); } catch { meanings = []; }
    const group = {
      surface: ch, base: null, matchLength: 1, kanji: true,
      entries: [{
        // Kept separate so the popup can label 音 and 訓 rows like a kanji
        // dictionary does, instead of one undifferentiated slash-run.
        reading: [k.on_yomi, k.kun_yomi].filter(Boolean).join(' / '),
        on: k.on_yomi || '', kun: k.kun_yomi || '',
        dict: 'KANJIDIC',
        glosses: meanings.slice(0, 5),
      }],
      pitch: [], freq: [],
    };
    return { ...group, groups: [group] };
  }
  return null;
}

module.exports = { lookup, open, initTransformer };
