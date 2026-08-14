// The dictionary list in the settings window.
//
// It used to be three lists — priority, downloadable, installed — and a
// dictionary could appear in two of them at once. Removing one left it behind
// in the priority list, still reorderable, answering nothing. One list means
// every dictionary is one row, and these check the properties that made the
// old arrangement wrong.
//
// The script is inline in settings.html and expects a browser, so it is
// evaluated against the smallest fake document that lets it build rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(
  path.resolve(__dirname, '../../app/settings/settings.html'), 'utf8');

function fakeElement(tag) {
  return {
    tag, children: [], className: '', textContent: '', innerHTML: '',
    style: {}, dataset: {}, disabled: false, type: '', checked: false,
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    get text() {
      return (this.textContent || '') + this.innerHTML
        + this.children.map((c) => c.text).join('');
    },
    buttons() {
      const out = this.tag === 'button' ? [this] : [];
      for (const c of this.children) out.push(...c.buttons());
      return out;
    },
  };
}

/** Load the settings script with just enough browser to run the list. */
function load(config) {
  const host = fakeElement('div');
  const document = {
    createElement: fakeElement,
    getElementById: () => host,
    querySelectorAll: () => [],
  };
  const src = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  // `config` is a top-level binding in the script, so it cannot also be a
  // parameter; assign it after the declarations have run.
  // setInterval is stubbed out too: the script starts a 2s window-list poll at
  // load, and a live timer keeps the test runner alive for ever.
  const make = new Function('document', 'window', '__config',
    'const setInterval = () => 0, setTimeout = () => 0;\n'
    + src + '\n;config = __config;\n;return { renderDictionaries };');
  // The script calls init() at load, which awaits the bridge. Give it shapes
  // it can use rather than undefined, or the failure surfaces long after the
  // test that caused it.
  const settings = {
    getConfig: async () => config,
    listWindows: async () => [],
    dictCatalogue: async () => [],
    dictInstalled: async () => [],
    onDictProgress: () => {},
    close: () => {},
  };
  const api = make(document, { settings }, config);
  return { api, host };
}

const CONFIG = {
  dictionaries: [{ name: 'Jitendex', enabled: true }, { name: '三省堂', enabled: false }],
};
const CATALOGUE = [
  { id: 'jitendex', name: 'Jitendex', detail: 'JA-EN', file: 'jitendex-yomitan.zip', installed: true },
  { id: 'jmnedict', name: 'JMnedict', detail: 'names', file: 'JMnedict.zip', installed: false },
];
const INSTALLED = [
  { file: 'jitendex-yomitan.zip', name: 'Jitendex', kind: 'term', size: 38e6 },
  { file: 'mono-sankoku8.zip', name: '三省堂', kind: 'term', size: 54e6 },
];

test('every dictionary appears exactly once', () => {
  const { api, host } = load(JSON.parse(JSON.stringify(CONFIG)));
  api.renderDictionaries(CATALOGUE, INSTALLED);
  const names = host.children.map((r) => r.text.match(/Jitendex|三省堂|JMnedict/)?.[0]);
  assert.deepStrictEqual(names.filter(Boolean).sort(),
                         ['JMnedict', 'Jitendex', '三省堂'].sort());
  assert.strictEqual(new Set(names).size, names.length, 'no duplicates across sections');
});

test('an installed dictionary offers Remove, an uninstalled one Download', () => {
  const { api, host } = load(JSON.parse(JSON.stringify(CONFIG)));
  api.renderDictionaries(CATALOGUE, INSTALLED);
  for (const row of host.children) {
    const labels = row.buttons().map((b) => b.textContent);
    const isInstalled = /Jitendex|三省堂/.test(row.text);
    assert.ok(labels.includes(isInstalled ? 'Remove' : 'Download'),
              `${row.text.slice(0, 20)} offers the right action (${labels.join(',')})`);
    // Never both — that was possible when the same dictionary sat in two lists.
    assert.ok(!(labels.includes('Remove') && labels.includes('Download')));
  }
});

test('a removed dictionary becomes downloadable again', () => {
  // What the app reports after a removal: gone from the config (config.js now
  // bounds the saved list by the manifest) and gone from installed, while the
  // catalogue reports it as no longer installed.
  const after = { dictionaries: [{ name: '三省堂', enabled: false }] };
  const cat = CATALOGUE.map((c) => ({ ...c, installed: false }));
  const { api, host } = load(after);
  api.renderDictionaries(cat, [INSTALLED[1]]);
  const jit = host.children.find((r) => /Jitendex/.test(r.text));
  assert.ok(jit, 'Jitendex still listed');
  assert.ok(jit.buttons().some((b) => b.textContent === 'Download'),
            'and can be downloaded again');
  assert.ok(!jit.buttons().some((b) => b.textContent === 'Remove'),
            'and is no longer removable');
});

test('order controls exist only for what is in the index', () => {
  const { api, host } = load(JSON.parse(JSON.stringify(CONFIG)));
  api.renderDictionaries(CATALOGUE, INSTALLED);
  const jmnedict = host.children.find((r) => /JMnedict/.test(r.text));
  const arrows = jmnedict.buttons().filter((b) => /[▲▼]/.test(b.textContent));
  assert.strictEqual(arrows.length, 0, 'nothing to reorder before it is installed');
  const jit = host.children.find((r) => /Jitendex/.test(r.text));
  assert.strictEqual(
    jit.buttons().filter((b) => /[▲▼]/.test(b.textContent)).length, 2,
    'an indexed dictionary can be moved up and down');
});
