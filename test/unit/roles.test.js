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
    tag, children: [], className: '', textContent: '', title: '',
    style: {}, dataset: {},
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
  return {
    createElement: el,
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

test('an image we cannot draw becomes its label, or nothing', () => {
  // Media is not extracted from archives yet, so every <img> would be broken.
  const titled = render(doc, { tag: 'img', title: '一', path: 'x/一-fill.svg' }, 'd');
  assert.strictEqual(titled.text, '一', 'the label it carries');

  const named = render(doc, { tag: 'img', path: 'sankoku8/二-fill.svg' }, 'd');
  assert.strictEqual(named.text, '二', 'or the marker its filename names');

  const anonymous = render(doc, { tag: 'img', path: 'meikyo/B92D.png' }, 'd');
  assert.strictEqual(anonymous.text, '',
                     'and decoration we cannot draw leaves nothing behind');
});

test('blank lines are collapsed, so a dropped image leaves no hole', () => {
  const node = render(doc, '筆順：\n\n\n（字義）', 'd');
  assert.strictEqual(node.textContent, '筆順：\n（字義）');
});
