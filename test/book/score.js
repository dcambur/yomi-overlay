// Scoring a recognised page against its ground truth. Pure functions: the
// harness hands them what the DOM said and what yomi said.

const norm = (s) => s.normalize('NFKC');

/** Edit distance between two arrays of characters. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Characters of a text, normalised the way the reader would see them equal. */
const glyphs = (s) => Array.from(norm(s)).filter((c) => !/\s/.test(c));

/** Character error rate of `read` against `truth` (both plain strings). */
function cer(read, truth) {
  const t = glyphs(truth);
  return t.length ? editDistance(glyphs(read), t) / t.length : 0;
}

/**
 * Of the truth's characters, how many have a recognised glyph of the same
 * character sitting on them. `read` is payload lines already in page points.
 */
function placement(truthLines, read) {
  const got = read.filter((l) => !l.ruby).flatMap((l) => l.chars);
  let total = 0, placed = 0;
  for (const line of truthLines) {
    for (const t of line.chars) {
      total++;
      const tc = norm(t.c);
      const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
      const ok = got.some((g) => norm(g.c) === tc &&
        Math.abs(g.x + g.w / 2 - cx) <= Math.max(8, t.w * 0.6) &&
        Math.abs(g.y + g.h / 2 - cy) <= Math.max(8, t.h * 0.6));
      if (ok) placed++;
    }
  }
  return { total, placed };
}

/**
 * The words a reader could point at on a line, as the dictionary segments it:
 * greedy longest match from the line's start, the way a reader's eye moves.
 * `lookup(glyphs)` is the app's own lookup.
 */
function words(line, lookup, maxLen = 12) {
  const cs = line.chars.map((c) => c.c);
  const out = [];
  for (let i = 0; i < cs.length;) {
    const r = /[\p{L}\p{N}]/u.test(cs[i]) ? lookup(cs.slice(i, i + maxLen)) : null;
    if (r && !r.kanji) {
      // What a reader points at: a word with a kanji in it, or a katakana word.
      // A lone kana is a particle or the tail of a word the column broke.
      const surface = cs.slice(i, i + r.matchLength).join('');
      if (/[\u3400-\u9fff\u3005]/.test(surface) || /^[\u30a0-\u30ff]{2,}/.test(surface)) {
        out.push({ at: i, term: r.base || r.surface, length: r.matchLength, r });
      }
      i += r.matchLength;
    } else i++;
  }
  return out;
}

/**
 * One word read two ways — 嚙み付く on the page, 噛み付く from the OCR — is the
 * same entry reached through a character variant: same reading, same senses.
 */
const sameWord = (a, b) => !!a && !!b && !!a.entries && !!b.entries &&
  a.entries[0].reading === b.entries[0].reading &&
  JSON.stringify(a.entries[0].glosses) === JSON.stringify(b.entries[0].glosses);

/** `n` items spread evenly over `list`, deterministic. */
function spread(list, n) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, k) => list[Math.floor((k + 0.5) * list.length / n)]);
}

module.exports = { editDistance, cer, placement, words, spread, glyphs, sameWord };
