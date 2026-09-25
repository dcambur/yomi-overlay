// Every dictionary's own vocabulary, translated to one the stylesheet knows.
//
// This is the difference between styling ONE dictionary and styling all of
// them. Jitendex marks a sense `data.content = "sense"`; 三省堂 marks the same
// thing `data.name = "語釈"`; 明鏡 uses `data.meikyo`. The stylesheet was
// written against Jitendex's names alone, so every rule in it fired for
// Jitendex and for nothing else — examples, cross-references and notes in the
// monolinguals all rendered identically to definitions.
//
// The node shapes below are real: they were read out of the installed
// archives, not invented. What is pinned here is that each one comes out
// carrying the role the stylesheet expects.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// The module is a browser IIFE hanging itself off window; give it one, and a
// document just big enough to build elements with.
function fakeDoc() {
  const el = (tag) => ({
    tag, children: [], className: '', textContent: '', title: '', src: '', alt: '',
    style: { setProperty(k, v) { this[k] = v; } }, dataset: {},
    classList: { add(n) { this.owner.className = (this.owner.className + ' ' + n).trim(); } },
    appendChild(c) { this.children.push(c); return c; },
    get text() {
      return (this.textContent || '') + this.children.map((c) => c.text).join('');
    },
    find(role) {
      const out = this.dataset.role === role ? [this] : [];
      for (const c of this.children) out.push(...(c.find ? c.find(role) : []));
      return out;
    },
  });
  const make = (tag) => { const e = el(tag); e.classList.owner = e; return e; };
  return {
    createElement: make,
    createTextNode: (t) => ({ tag: '#text', textContent: t, children: [],
                              text: t, find: () => [] }),
    createDocumentFragment: () => el('#fragment'),
  };
}

global.window = global.window || {};
require(path.resolve(__dirname, '../../app/renderer/structured.js'));
const { render } = global.window.structured;

const doc = fakeDoc();
const roleOf = (node) => {
  const out = render(doc, node, 'test');
  return out.dataset ? out.dataset.role : '';
};

test('a sense is a sense, whichever dictionary says so', () => {
  assert.strictEqual(roleOf({ tag: 'div', data: { content: 'sense' } }), 'sense',
                     'Jitendex');
  assert.strictEqual(roleOf({ tag: 'span', data: { name: '語釈' } }), 'sense',
                     '三省堂');
});

test('the roles the stylesheet depends on all arrive', () => {
  const cases = [
    [{ data: { content: 'example-sentence' } }, 'example', 'Jitendex example'],
    [{ data: { name: '用例G' } }, 'example', '三省堂 example'],
    [{ data: { content: 'glossary' } }, 'glossary', 'Jitendex glossary'],
    [{ data: { content: 'part-of-speech-info' } }, 'tag', 'Jitendex tag'],
    [{ data: { name: '品詞G' } }, 'tag', '三省堂 tag'],
    [{ data: { content: 'xref' } }, 'xref', 'Jitendex cross-reference'],
    [{ data: { name: '対義語G' } }, 'xref', '三省堂 antonym'],
    [{ data: { content: 'sense-note-label' } }, 'note-label', 'Jitendex note label'],
    [{ data: { name: '表記' } }, 'note', '三省堂 spelling note'],
    [{ data: { name: '大語義' } }, 'division', '三省堂 division'],
    [{ data: { name: '語義番号' } }, 'sense-num', '三省堂 sense number'],
    [{ data: { meikyo: 'furigana' } }, 'furigana', '明鏡 furigana'],
    [{ data: { name: 'ルビG' } }, 'furigana', '三省堂 furigana'],
    [{ data: { content: 'attribution' } }, 'meta', 'licence footer'],
    [{ data: { content: 'forms' } }, 'meta', 'spelling-variant table'],
  ];
  for (const [node, want, what] of cases) {
    assert.strictEqual(roleOf({ tag: 'span', ...node }), want, what);
  }
});

test('a node claiming a role by the image it stands in for', () => {
  // 三省堂 names these nodes "img" and puts the meaning in the filename: the
  // core-vocabulary rank arrived as two asterisks glued to the headword.
  const core = { tag: 'span', data: { name: 'img', src: 'svg-logo/最重要語.svg' },
                 style: { fontSize: '0.6em', verticalAlign: 'super' },
                 content: '＊＊' };
  const el = render(doc, core, 'test');
  assert.strictEqual(el.dataset.role, 'core');
  // Not overridden — never applied. There is nothing to override an inline
  // style with from a stylesheet.
  assert.ok(!el.style.fontSize, 'the dictionary\'s own sizing is dropped');
  assert.ok(!el.style.verticalAlign, 'and its superscript with it');
  assert.ok(el.title, 'and it says what it means');
});

test('a name no dictionary here uses simply has no role', () => {
  assert.strictEqual(roleOf({ tag: 'span', data: { content: 'whatever-new' } }), undefined);
  assert.strictEqual(roleOf({ tag: 'span' }), undefined);
});

test('a named monochrome mark is set as text, not drawn', () => {
  // 三省堂 draws its 一 二 三 divisions and its part-of-speech tags as 128px
  // glyphs meant to be tinted to the text colour. As text they align with the
  // line and stay legible at 11px; as images they are a grey smudge, and the
  // tinting is not available to a page whose policy refuses a CSS mask URL.
  const mark = { tag: 'img', appearance: 'monochrome', title: '一',
                 path: 'sankoku8/一-fill.svg' };
  const el = render(doc, mark, 'd');
  assert.strictEqual(el.tag, 'span', 'text, not an image');
  assert.strictEqual(el.text, '一');

  // The filename names it too, which is how the markers past ⓴ survive.
  const unnamed = render(doc, { tag: 'img', appearance: 'monochrome',
                                path: 'sankoku8/二-fill.svg' }, 'd');
  assert.strictEqual(unnamed.text, '二');
});

test('a picture is drawn, and says what it is if it cannot be', () => {
  const el = render(doc, { tag: 'img', path: 'img/plant.avif', title: 'Cannabis' }, '辞');
  assert.strictEqual(el.tag, 'img', 'an illustration is an image');
  assert.match(el.src, /^yomi-media:\/\/media\/%E8%BE%9E\//, 'served from its own archive');
  assert.strictEqual(el.alt, 'Cannabis',
                     'and names itself if the archive no longer has the file');
});

test('line art with no name is drawn, and made visible', () => {
  // Black on transparent, on a dark panel. Nothing names it, so there is no
  // text to fall back to — it has to be shown, and shown inverted.
  const el = render(doc, { tag: 'img', appearance: 'monochrome',
                           path: 'meikyo/B92D.png' }, 'd');
  assert.strictEqual(el.tag, 'img');
  assert.ok(el.className.includes('sc-mono'), 'marked for inversion');
});

test('with images turned off, a picture becomes what it is called', () => {
  // The setting exists because a dictionary is already big and not everyone
  // wants pictures in a reading popup. What survives is the label, which for
  // a sense mark is its whole meaning.
  global.window.viewOptions = { images: false };
  const el = render(doc, { tag: 'img', path: 'img/plant.avif', title: 'Cannabis' }, 'd');
  assert.strictEqual(el.tag, 'span', 'no image is built at all');
  assert.strictEqual(el.text, 'Cannabis');
  // And one that cannot be named leaves nothing rather than a gap.
  assert.strictEqual(render(doc, { tag: 'img', path: 'x/B92D.png' }, 'd').text, '');
  delete global.window.viewOptions;
});

test('an image with no file and no name leaves nothing behind', () => {
  const el = render(doc, { tag: 'img' }, 'd');
  assert.strictEqual(el.text, '', 'not an empty element — there were 348 on one page');
});

test('blank lines are collapsed, so a dropped image leaves no hole', () => {
  const node = render(doc, '筆順：\n\n\n（字義）', 'd');
  assert.strictEqual(node.textContent, '筆順：\n（字義）');
});
