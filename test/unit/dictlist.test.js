// The dictionary list in the settings window.
//
// It used to be three lists — priority, downloadable, installed — and a
// dictionary could appear in two of them at once. Removing one left it behind
// in the priority list, still reorderable, answering nothing. It is now one row
// per dictionary under one of two headings — what we can fetch, and what the
// user brought themselves — and these check the properties that made the old
// arrangement wrong, plus the ones the grouping must not quietly reintroduce.
//
// settings.js is a classic script that expects a browser, so it is evaluated
// against the smallest fake document that lets it build rows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../app/settings/settings.js'), 'utf8');

function fakeElement(tag) {
  const el = {
    tag, children: [], className: '', textContent: '', innerHTML: '',
    style: {}, dataset: {}, disabled: false, type: '', checked: false,
    // Backed by className, like the real one: the script reads both.
    classList: {
      contains(n) { return this.owner.className.split(' ').includes(n); },
      add(n) { if (!this.contains(n)) this.owner.className += ' ' + n; },
      remove(n) {
        this.owner.className = this.owner.className.split(' ')
          .filter((c) => c !== n).join(' ');
      },
      toggle(n, on) { if (on) this.add(n); else this.remove(n); },
    },
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
    /** Every element under here whose class contains `name`. */
    withClass(name) {
      const out = this.className.split(' ').includes(name) ? [this] : [];
      for (const c of this.children) out.push(...c.withClass(name));
      return out;
    },
  };
  el.classList.owner = el;
  return el;
}

/**
 * Load the settings script with just enough browser to run the list.
 *
 * The catalogue and the installed set are module-level state the script fills
 * from the bridge, so the harness assigns them directly rather than pretending
 * to be an async bridge; same for the busy row, which is what decides whether a
 * progress bar is drawn.
 */
function load(config) {
  const host = fakeElement('div');
  const document = {
    createElement: fakeElement,
    getElementById: () => host,
    querySelectorAll: () => [],
  };
  // `config` is a top-level binding in the script, so it cannot also be a
  // parameter; assign it after the declarations have run.
  // setInterval is stubbed out too: the script starts a 2s window-list poll at
  // load, and a live timer keeps the test runner alive for ever.
  const make = new Function('document', 'window', '__config',
                            'const setInterval = () => 0, setTimeout = () => 0;\n'
    + SRC + '\n;config = __config;\n'
    + ';return { render(cat, inst, busy = null, prog = null) {\n'
    + '   lastCatalogue = cat; lastInstalled = inst;\n'
    + '   dictBusy = busy; dictProgress = prog;\n'
    + '   renderDictionaries(); } };');
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

/** The rows, without the group headings between them. */
const rowsOf = (host) => host.children.filter((c) => c.className.startsWith('dict'));
const rowFor = (host, name) => rowsOf(host).find((r) => r.text.includes(name));

// Jitendex is in the catalogue and installed; JMnedict is in the catalogue and
// not; 明鏡 is installed but in no catalogue — i.e. imported by the user.
const CONFIG = {
  dictionaries: [{ name: 'Jitendex', enabled: true }, { name: '明鏡', enabled: false }],
};
const CATALOGUE = [
  { id: 'jitendex', label: 'Jitendex', name: 'Jitendex', detail: 'JA-EN' },
  { id: 'jmnedict', label: 'Names', name: 'JMnedict', detail: 'names' },
];
const INSTALLED = [
  { file: 'jitendex-yomitan.zip', label: 'Jitendex', name: 'Jitendex',
    kind: 'term', size: 38e6 },
  { file: 'meikyo.zip', label: '明鏡', name: '明鏡', kind: 'term', size: 54e6 },
];
const fresh = () => JSON.parse(JSON.stringify(CONFIG));

test('every dictionary appears exactly once', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  const names = rowsOf(host)
    .map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]).filter(Boolean);
  assert.deepStrictEqual(names.sort(), ['JMnedict', 'Jitendex', '明鏡'].sort());
  assert.strictEqual(new Set(names).size, names.length, 'no duplicates across groups');
});

test('the two groups are what they say they are', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  // Headings are the only non-row children, in order, each above its rows.
  const heads = host.children
    .filter((c) => c.className.split(' ').includes('group-head'));
  assert.strictEqual(heads.length, 2, 'one heading per group');
  const [first, second] = heads.map((h) => host.children.indexOf(h));
  const between = host.children.slice(first + 1, second);
  const after = host.children.slice(second + 1);
  const named = (list) => list.filter((c) => c.className.startsWith('dict'))
    .map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]);
  assert.deepStrictEqual(named(between).sort(), ['JMnedict', 'Jitendex'],
                         'the catalogue is the first group');
  assert.deepStrictEqual(named(after), ['明鏡'],
                         'what the user imported is the second');
});

test('an installed dictionary offers Remove, an uninstalled one Download', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  for (const row of rowsOf(host)) {
    const labels = row.buttons().map((b) => b.textContent);
    const isInstalled = /Jitendex|明鏡/.test(row.text);
    assert.ok(labels.includes(isInstalled ? 'Remove' : 'Download'),
              `${row.text.slice(0, 20)} offers the right action (${labels.join(',')})`);
    // Never both — that was possible when the same dictionary sat in two lists.
    assert.ok(!(labels.includes('Remove') && labels.includes('Download')));
  }
});

test('a row reads on/off, priority, name, action', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  const row = rowFor(host, 'Jitendex');
  assert.strictEqual(row.children[0].type, 'checkbox', 'the checkbox leads');
  assert.strictEqual(row.children[1].className, 'move', 'then priority');
  assert.strictEqual(row.children[2].className, 'grow', 'then what it is');
  assert.strictEqual(row.children.at(-1).tag, 'button', 'action on the right');
  assert.strictEqual(row.children.at(-1).textContent, 'Remove');
  // Clicking the name still toggles the box now that the two are siblings.
  assert.strictEqual(row.children[2].htmlFor, row.children[0].id,
                     'the name labels the checkbox');
});

test('a removed dictionary becomes downloadable again', () => {
  // What the app reports after a removal: gone from the config (config.js now
  // bounds the saved list by the manifest) and gone from installed.
  const { api, host } = load({ dictionaries: [{ name: '明鏡', enabled: false }] });
  api.render(CATALOGUE, [INSTALLED[1]]);
  const jit = rowFor(host, 'Jitendex');
  assert.ok(jit, 'Jitendex still listed');
  assert.ok(jit.buttons().some((b) => b.textContent === 'Download'),
            'and can be downloaded again');
  assert.ok(!jit.buttons().some((b) => b.textContent === 'Remove'),
            'and is no longer removable');
});

test('anything installed can be reordered, catalogue or not', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  const arrows = (row) => row.buttons().filter((b) => /[▲▼]/.test(b.textContent));
  // The point of the rewrite: priority is a property of every dictionary the
  // index holds, not of the ones we happen to ship a download for.
  assert.strictEqual(arrows(rowFor(host, '明鏡')).length, 2,
                     'an imported dictionary can be moved too');
  assert.strictEqual(arrows(rowFor(host, 'Jitendex')).length, 2,
                     'so can one we downloaded');
  assert.strictEqual(arrows(rowFor(host, 'JMnedict')).length, 0,
                     'nothing to reorder before it is installed');
});

test('reordering moves the dictionary and redraws', () => {
  const config = fresh();
  const { api, host } = load(config);
  api.render(CATALOGUE, INSTALLED);
  const down = rowFor(host, 'Jitendex').buttons()
    .find((b) => b.textContent === '▼');
  down.onclick();
  assert.deepStrictEqual(config.dictionaries.map((d) => d.name), ['明鏡', 'Jitendex'],
                         'the config list is what actually moved');
});

test('progress is drawn on the busy row, and only there', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, '明鏡',
             { phase: 'pruning', step: 'terms', done: 3, total: 4 });
  const busy = rowFor(host, '明鏡').withClass('prog');
  assert.strictEqual(busy.length, 1, 'the row being worked on shows a bar');
  assert.match(busy[0].text, /removing 75%/, 'with what it is doing, and how far');
  assert.strictEqual(busy[0].withClass('fill')[0].style.width, '75%',
                     'and the bar is filled to match');
  assert.strictEqual(rowFor(host, 'Jitendex').withClass('prog').length, 0,
                     'no other row does');
});

test('a step that has just started reads zero, not done', () => {
  // The bar drew "indexing 100%" the moment an install began: the builder
  // reports how many units have FINISHED, and this added one to it.
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, 'Jitendex',
             { phase: 'indexing', done: 0, total: 4 });
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.strictEqual(bar.text, 'indexing 0%');
  assert.strictEqual(bar.withClass('fill')[0].style.width, '0%');
});

test('an unmeasurable step still shows what it is doing', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, 'Jitendex', { phase: 'downloading' });
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.strictEqual(bar.text, 'downloading', 'named, without a false percentage');
  assert.ok(bar.withClass('fill')[0].className.includes('indeterminate'));
});

test('nothing is actionable while something else is working', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, '明鏡', { phase: 'pruning' });
  for (const row of rowsOf(host)) {
    for (const b of row.buttons()) {
      assert.ok(b.disabled, `${row.text.slice(0, 12)}: ${b.textContent} is disabled`);
    }
  }
});
