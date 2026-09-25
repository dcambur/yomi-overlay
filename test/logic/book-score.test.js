// The book lane's scorer, scored: a number the lane reports is only as good as
// the arithmetic behind it, and a scorer that is wrong in the lane's favour
// passes every book.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const score = require(path.resolve(__dirname, '..', 'book', 'score.js'));

const line = (text, x0 = 0) => ({
  text, chars: Array.from(text).map((c, i) => ({ c, x: x0 + i * 20, y: 0, w: 20, h: 20 })) });

test('edit distance counts substitutions, insertions and deletions', () => {
  assert.strictEqual(score.editDistance([...'瓦礫'], [...'瓦礫']), 0);
  assert.strictEqual(score.editDistance([...'瓦機'], [...'瓦礫']), 1);
  assert.strictEqual(score.editDistance([...'瓦'], [...'瓦礫']), 1);
  assert.strictEqual(score.editDistance([...'瓦礫を'], [...'瓦を']), 1);
});

test('the error rate ignores spacing and compares as NFKC', () => {
  assert.strictEqual(score.cer('第１話 アキラ', '第1話アキラ'), 0);
  assert.strictEqual(score.cer('', '瓦礫'), 1);
  assert.strictEqual(score.cer('瓦機を', '瓦礫を'), 1 / 3);
});

test('a glyph counts as placed only on its own character', () => {
  const truth = [line('少年の頭')];
  assert.deepStrictEqual(score.placement(truth, [line('少年の頭')]), { total: 4, placed: 4 });
  // Shifted by a whole glyph: every character is next to, not on, itself.
  assert.strictEqual(score.placement(truth, [line('少年の頭', 20)]).placed, 0);
  // A ruby line sitting on the text places nothing.
  assert.strictEqual(score.placement(truth, [{ ...line('少年の頭'), ruby: true }]).placed, 0);
});

test('words are what a reader points at, not particles', () => {
  const dict = { 少年: 2, 頭: 1, アキラ: 3 };
  const lookup = (g) => {
    for (let n = Math.min(g.length, 4); n > 0; n--) {
      const s = g.slice(0, n).join('');
      if (dict[s]) return { surface: s, matchLength: n };
    }
    return g[0] === 'の' ? { surface: 'の', matchLength: 1 } : null;
  };
  const w = score.words(line('少年の頭'), lookup);
  assert.deepStrictEqual(w.map((x) => x.term), ['少年', '頭']);
  assert.deepStrictEqual(score.words(line('アキラの'), lookup).map((x) => x.term), ['アキラ']);
});

test('the same entry reached through a variant is the same word', () => {
  const e = (reading, glosses) => ({ entries: [{ reading, glosses }] });
  assert.ok(score.sameWord(e('かみつく', ['to bite']), e('かみつく', ['to bite'])));
  assert.ok(!score.sameWord(e('かみつく', ['to bite']), e('かわら', ['tile'])));
  assert.ok(!score.sameWord(null, e('かわら', ['tile'])));
});

test('a sample is spread over the list, and all of a short one', () => {
  assert.deepStrictEqual(score.spread([1, 2, 3], 10), [1, 2, 3]);
  assert.deepStrictEqual(score.spread([...Array(10).keys()], 2), [2, 7]);
});
