// The sentence slice behind the Anki card (app/renderer/sentence.js).
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

const win = {};
const src = fs.readFileSync(path.join(ROOT, 'app', 'renderer', 'sentence.js'), 'utf8');
new Function('window', src)(win);
const { around, markup, region, MAX_SENTENCE_GLYPHS } = win.sentence;

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
  const s = around(B.lines, ...find(B, '名前'));
  assert.strictEqual(s.text, '名前はまだ無い。');
  assert.deepStrictEqual(s.runs, [{ li: 0, ci: 8, n: 8 }]);
});

test('a line break is where the page wrapped, not where the sentence ended', () => {
  const s = around(B.lines, ...find(B, '何でも'));
  assert.strictEqual(s.text, '何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。');
  assert.strictEqual(s.runs.length, 2, 'two runs, one per line');
  assert.strictEqual(s.runs[0].li, 0);
  assert.strictEqual(s.runs[1].li, 1);
  assert.strictEqual(s.runs.reduce((n, r) => n + r.n, 0), s.glyphs);
});

test('a tategaki sentence spanning columns, pointed at in its last column', () => {
  const [li, ci] = find(A, 'が目の前');
  const s = around(A.lines, li, ci);
  assert.ok(s.text.startsWith('春が目覚めると'), s.text);
  assert.ok(s.text.endsWith('が目の前にあった。'), s.text);
  assert.strictEqual(s.runs[0].li, li - 1, 'starts in the previous column');
});

test('the first sentence on the page has no terminator before it', () => {
  const s = around(B.lines, 0, 0);
  assert.strictEqual(s.text, '吾輩は猫である。');
});

test('a ruby line between two columns is skipped, not read', () => {
  const page = JSON.parse(JSON.stringify(A));
  const [li] = find(page, 'が目の前');
  const chars = Array.from('しゅん', (c) => ({ c, x: 0, y: 0, w: 1, h: 1 }));
  page.lines.splice(li, 0, { text: 'しゅん', ruby: true, chars });
  const s = around(page.lines, li + 1, 0);
  assert.ok(!s.text.includes('しゅん'), s.text);
  assert.ok(s.text.startsWith('春が目覚めると'), s.text);
});

test('a page with no punctuation is capped, keeping the pointed-at glyph', () => {
  const chars = Array.from({ length: 400 }, (_, i) =>
    ({ c: String.fromCharCode(0x3042 + (i % 40)), x: i, y: 0, w: 1, h: 1 }));
  const lines = [{ text: chars.map((c) => c.c).join(''), chars }];
  const s = around(lines, 0, 300);
  assert.strictEqual(s.glyphs, MAX_SENTENCE_GLYPHS);
  assert.strictEqual(s.runs[0].ci, 300 - (MAX_SENTENCE_GLYPHS >> 1));
});

test('a glyph that is not on the page yields nothing', () => {
  assert.strictEqual(around(B.lines, 9, 9), null);
});

// --- blocks: where a sentence may not cross a line break ---------------------

/** A horizontal line of `text` at (x, y), 24px glyphs. */
function hline(text, x, y, size = 24) {
  const chars = Array.from(text, (c, i) => ({ c, x: x + i * size, y, w: size, h: size }));
  return { text, chars };
}

test('a heading column is not the start of the sentence below it', () => {
  // page-a: 第1章 綵月宮 / 第1話 プロローグ / 一体どうなってるんだ……。 — the
  // headings have no 。 and a plain walk read all three as one sentence.
  const [li, ci] = find(A, '一体');
  const s = around(A.lines, li, ci, true);
  assert.strictEqual(s.text, '一体どうなってるんだ・・・・・・。');
  const heading = around(A.lines, ...find(A, 'プロローグ'), true);
  assert.ok(!heading.text.includes('一体'), heading.text);
});

test('a metadata row is its own block; the next title does not inherit it', () => {
  // The syosetu ranking that sent author + stars + tags + date + next title.
  const lines = [
    hline('転移したら山の中だった。', 100, 100),
    hline('選びました。／じゃがバター', 100, 130),
    hline('★73,648 ・ 書籍化 ・', 100, 170, 20),
    hline('2026年9月18日更新', 100, 195, 20),
    hline('才能に恵まれ過ぎた極悪貴族が、', 100, 300),
    hline('油断も慢心もせず、謙虚堅実に努力したら', 100, 330),
  ];
  const title = around(lines, 4, 3, false);
  assert.strictEqual(title.text, '才能に恵まれ過ぎた極悪貴族が、油断も慢心もせず、謙虚堅実に努力したら');
  const meta = around(lines, 2, 1, false);
  assert.strictEqual(meta.text, '★73,648 ・ 書籍化 ・');
  const author = around(lines, 1, 7, false);
  assert.strictEqual(author.text, '／じゃがバター', 'stops at the metadata row below');
});

test('a line in the other column is not the continuation', () => {
  const lines = [
    hline('左の段落はここから始まって', 40, 100),
    hline('右の段の最初の行です', 600, 100),
    hline('次の行に続いています。', 40, 130),
    hline('右の段の二行目。', 600, 130),
  ];
  const s = around(lines, 0, 2, false);
  assert.strictEqual(s.text, '左の段落はここから始まって次の行に続いています。');
});

test('a manga bubble keeps its centred lines together', () => {
  const lines = [
    hline('この街に', 130, 100),
    hline('来たのは', 130, 126),
    hline('初めてだ', 130, 152),
    hline('そうか', 400, 400),     // another bubble, far away
    hline('よかった', 400, 426),
  ];
  const s = around(lines, 1, 0, false);
  assert.strictEqual(s.text, 'この街に来たのは初めてだ');
  assert.strictEqual(around(lines, 4, 0, false).text, 'そうかよかった');
});

// --- what the card gets ------------------------------------------------------

test('the matched glyphs are bolded once, everything else escaped', () => {
  const [li, ci] = find(B, '何でも');
  const s = around(B.lines, li, ci);
  // 記憶している sits on the second line: the run crosses the wrap and the
  // <b> must still land on exactly those glyphs.
  const hit = [B.lines[1], B.lines[1].text.indexOf('記憶')];
  const html = markup(B.lines, s, { li: 1, ci: hit[1], n: 2 });
  assert.strictEqual(html, '何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは<b>記憶</b>している。');
  assert.strictEqual((html.match(/<b>/g) || []).length, 1);
});

test('markup escapes what the page printed', () => {
  const lines = [hline('a<b>&"c', 0, 0)];
  const s = around(lines, 0, 0);
  assert.strictEqual(markup(lines, s, { li: 0, ci: 0, n: 1 }),
                     '<b>a</b>&lt;b&gt;&amp;&quot;c');
});

test('the region is the sentence box padded by one glyph', () => {
  const lines = [hline('この街に', 130, 100), hline('来たのは', 130, 126)];
  const s = around(lines, 0, 0, false);
  assert.deepStrictEqual(region(lines, s),
                         { x: 130 - 24, y: 100 - 24, w: 4 * 24 + 48, h: 26 + 24 + 48 });
});
