// The sentence slice behind the explain key (app/renderer/explain.js).
//
// Runs the renderer file in plain node: it is a classic script that hangs one
// namespace on `window`, so a stand-in window is all it needs. The pages are
// the captured payloads the renderer suite already uses — real OCR of real
// pages, one vertical novel page and one horizontal — not lines written to
// agree with the slicer.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const load = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

const win = { overlay: { onExplainConfig() {} } };
const doc = { addEventListener() {}, getElementById() { return null; } };
const src = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'explain.js'), 'utf8');
new Function('window', 'document', src)(win, doc);
const { sentenceAround, MAX_SENTENCE_GLYPHS } = win.explain;

const A = load('page-a.json');   // vertical: 春が目覚めると… wraps over three columns
const B = load('page-b.json');   // horizontal: 吾輩は猫である。名前はまだ無い。…

/** (li, ci) of the first occurrence of `needle` in the page's lines. */
function find(page, needle) {
  for (let li = 0; li < page.lines.length; li++) {
    const ci = page.lines[li].text.indexOf(needle);
    if (ci >= 0) return [li, ci];
  }
  throw new Error(`${needle} not on the page`);
}

test('a sentence inside one line: back to the previous 。, through the next', () => {
  const s = sentenceAround(B.lines, ...find(B, '名前'));
  assert.strictEqual(s.text, '名前はまだ無い。');
  assert.deepStrictEqual(s.runs, [{ li: 0, ci: 8, n: 8 }]);
});

test('a line break is where the page wrapped, not where the sentence ended', () => {
  const s = sentenceAround(B.lines, ...find(B, '何でも'));
  assert.strictEqual(s.text, '何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。');
  assert.strictEqual(s.runs.length, 2, 'two runs, one per line');
  assert.strictEqual(s.runs[0].li, 0);
  assert.strictEqual(s.runs[1].li, 1);
  assert.strictEqual(s.runs.reduce((n, r) => n + r.n, 0), s.glyphs);
});

test('a tategaki sentence spanning columns, pointed at in its last column', () => {
  const [li, ci] = find(A, 'が目の前');
  const s = sentenceAround(A.lines, li, ci);
  assert.ok(s.text.startsWith('春が目覚めると'), s.text);
  assert.ok(s.text.endsWith('が目の前にあった。'), s.text);
  assert.strictEqual(s.runs[0].li, li - 1, 'starts in the previous column');
});

test('the first sentence on the page has no terminator before it', () => {
  const s = sentenceAround(B.lines, 0, 0);
  assert.strictEqual(s.text, '吾輩は猫である。');
});

test('a ruby line between two columns is skipped, not read', () => {
  const page = JSON.parse(JSON.stringify(A));
  const [li] = find(page, 'が目の前');
  const chars = Array.from('しゅん', (c) => ({ c, x: 0, y: 0, w: 1, h: 1 }));
  page.lines.splice(li, 0, { text: 'しゅん', ruby: true, chars });
  const s = sentenceAround(page.lines, li + 1, 0);
  assert.ok(!s.text.includes('しゅん'), s.text);
  assert.ok(s.text.startsWith('春が目覚めると'), s.text);
});

test('a page with no punctuation is capped, keeping the pointed-at glyph', () => {
  const chars = Array.from({ length: 400 }, (_, i) =>
    ({ c: String.fromCharCode(0x3042 + (i % 40)), x: i, y: 0, w: 1, h: 1 }));
  const lines = [{ text: chars.map((c) => c.c).join(''), chars }];
  const s = sentenceAround(lines, 0, 300);
  assert.strictEqual(s.glyphs, MAX_SENTENCE_GLYPHS);
  assert.strictEqual(s.runs[0].ci, 300 - (MAX_SENTENCE_GLYPHS >> 1));
});

test('a glyph that is not on the page yields nothing', () => {
  assert.strictEqual(sentenceAround(B.lines, 9, 9), null);
});
