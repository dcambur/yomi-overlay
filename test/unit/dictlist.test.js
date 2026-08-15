// The dictionary list in the settings window.
//
// It used to be three lists — priority, downloadable, installed — and a
// dictionary could appear in two of them at once. Removing one left it behind
// in the priority list, still reorderable, answering nothing. It is now one row
// per dictionary under one of two headings, split by STATE: installed (in
// priority order) and available to download. These check the properties that
// made the old arrangement wrong, and the one that a provenance split broke —
// that the order you see is the order that is saved.
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
    tag, children: [], className: '', textContent: '', _html: '',
    style: {}, dataset: {}, disabled: false, type: '', checked: false,
    // A real element drops its children when innerHTML is assigned. Without
    // that, a re-render appended to the previous one and every "did the rows
    // move" assertion saw both renders at once.
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (!v) this.children = []; },
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
  let onProgress = () => {};
  const host = fakeElement('div');
  // One element per id, rather than the same one for everything: the script
  // now sets state on elements OTHER than the list — the import button's
  // disabled flag, the footer button's visibility — and a shared stub cannot
  // tell those apart.
  const elements = new Map([['dictlist', host]]);
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement('div'));
    return elements.get(id);
  };
  const document = {
    createElement: fakeElement,
    getElementById: byId,
    querySelectorAll: () => [],
  };
  // `config` is a top-level binding in the script, so it cannot also be a
  // parameter; assign it after the declarations have run.
  // setInterval is stubbed out too: the script starts a 2s window-list poll at
  // load, and a live timer keeps the test runner alive for ever.
  const make = new Function('document', 'window', '__config',
                            'const setInterval = () => 0, setTimeout = () => 0;\n'
    + SRC + '\n;config = __config;\n'
    + ';return { render(cat, inst, jobs = []) {\n'
    + '   lastCatalogue = cat; lastInstalled = inst;\n'
    + '   dictJobs.clear();\n'
    + '   for (const [k, v] of jobs) dictJobs.set(k, v);\n'
    + '   renderDictionaries(); },\n'
    + '  jobs: () => dictJobs };');
  // The script calls init() at load, which awaits the bridge. Give it shapes
  // it can use rather than undefined, or the failure surfaces long after the
  // test that caused it.
  const saved = [];
  const imported = [];
  const settings = {
    getConfig: async () => config,
    // Priority and on/off apply immediately; the harness records the calls so
    // a test can assert that they DID.
    saveDictionaries: (list) => { saved.push(list.map((d) => d.name)); },
    listWindows: async () => [],
    dictCatalogue: async () => [],
    dictInstalled: async () => [],
    dictImport: async (job) => { imported.push(job); return { ok: true }; },
    onDictProgress: (fn) => { onProgress = fn; },
    close: () => {},
  };
  const api = make(document, { settings }, config);
  // The script's own progress listener, callable from out here: the harness
  // records it when the script registers it, and the wrapper cannot reach a
  // binding in this scope.
  api.progress = (p) => onProgress(p);
  return { api, host, saved, imported, el: byId };
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
  const named = (list) => list.filter((c) => c.className.startsWith('dict'))
    .map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]);
  assert.deepStrictEqual(named(host.children.slice(first + 1, second)).sort(),
                         ['Jitendex', '明鏡'].sort(),
                         'everything in the index is in the first group');
  assert.deepStrictEqual(named(host.children.slice(second + 1)), ['JMnedict'],
                         'and what is not installed is in the second');
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

test('reordering moves the dictionary and saves at once', () => {
  const config = fresh();
  const { api, host, saved } = load(config);
  api.render(CATALOGUE, INSTALLED);
  const down = rowFor(host, 'Jitendex').buttons()
    .find((b) => b.textContent === '▼');
  down.onclick();
  assert.deepStrictEqual(config.dictionaries.map((d) => d.name), ['明鏡', 'Jitendex'],
                         'the config list is what actually moved');
  assert.deepStrictEqual(saved, [['明鏡', 'Jitendex']],
                         'and it was written without waiting for a button');
});

test('the arrows swap with the row you can SEE, not the saved neighbour', () => {
  // A dictionary the catalogue lists but nobody installed has no place in the
  // priority list, so it must not sit between two rows that swap.
  const config = fresh();
  const { api, host } = load(config);
  api.render(CATALOGUE, INSTALLED);
  const before = rowsOf(host).map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]);
  rowFor(host, 'Jitendex').buttons().find((b) => b.textContent === '▼').onclick();
  const after = rowsOf(host).map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]);
  assert.notDeepStrictEqual(after, before, 'the rows actually moved');
  assert.strictEqual(after.indexOf('明鏡') < after.indexOf('Jitendex'), true,
                     `明鏡 is now above Jitendex (${after.join(', ')})`);
});

test('installed dictionaries are listed in priority order', () => {
  const config = { dictionaries: [{ name: '明鏡', enabled: true },
                                  { name: 'Jitendex', enabled: true }] };
  const { api, host } = load(config);
  api.render(CATALOGUE, INSTALLED);
  const names = rowsOf(host).map((r) => r.text.match(/Jitendex|明鏡|JMnedict/)?.[0]);
  assert.ok(names.indexOf('明鏡') < names.indexOf('Jitendex'),
            `saved order is the shown order (${names.join(', ')})`);
});

test('turning a dictionary off saves without a button press', () => {
  const config = fresh();
  const { api, host, saved } = load(config);
  api.render(CATALOGUE, INSTALLED);
  const box = rowFor(host, 'Jitendex').children[0];
  box.checked = false;
  box.onchange();
  assert.strictEqual(config.dictionaries[0].enabled, false);
  assert.strictEqual(saved.length, 1, 'written immediately');
});

test('progress is drawn on the busy row, and only there', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED,
             [['明鏡', { phase: 'pruning', step: 'terms', done: 3, total: 4 }]]);
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
  api.render(CATALOGUE, INSTALLED, [['Jitendex', { phase: 'indexing', done: 0, total: 4 }]]);
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.strictEqual(bar.text, 'indexing 0%');
  assert.strictEqual(bar.withClass('fill')[0].style.width, '0%');
});

test('an unmeasurable step still shows what it is doing', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, [['Jitendex', { phase: 'downloading' }]]);
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.strictEqual(bar.text, 'downloading', 'named, without a false percentage');
  assert.ok(bar.withClass('fill')[0].className.includes('indeterminate'));
});

test('a row with work outstanding is inert; the others are not', () => {
  // The whole list used to freeze while anything ran, which is why "Import a
  // .zip you own…" looked clickable and did nothing. Work is queued in the
  // main process now, so only the row already waiting is out of action.
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED, [['明鏡', { phase: 'pruning' }]]);
  const busyRow = rowFor(host, '明鏡');
  assert.ok(busyRow.buttons().every((b) => b.disabled), 'the working row is inert');
  const other = rowFor(host, 'JMnedict');
  assert.ok(other.buttons().some((b) => b.textContent === 'Download' && !b.disabled),
            'another dictionary can still be asked for');
});

test('queued work says so on its own row', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED,
             [['明鏡', { phase: 'pruning', done: 1, total: 4 }],
              ['Names', { phase: 'queued' }]]);
  assert.match(rowFor(host, '明鏡').withClass('prog')[0].text, /removing 25%/);
  assert.match(rowFor(host, 'JMnedict').withClass('prog')[0].text, /waiting/,
               'the one behind it is told it is waiting');
});

test('imports queue behind each other and behind everything else', () => {
  // Nothing blocks an import. It used to block after the first: every import
  // shared one job key, so the second looked like the first still running.
  const { api, el, imported } = load(fresh());
  api.render(CATALOGUE, INSTALLED, [['Jitendex', { phase: 'downloading' }]]);
  assert.strictEqual(el('import').disabled, false, 'live while a download runs');
  el('import').onclick();
  el('import').onclick();
  assert.strictEqual(imported.length, 2, 'two imports were asked for');
  assert.notStrictEqual(imported[0], imported[1], 'and they are two jobs');
});

test('an import reports beside the button, having no row of its own', () => {
  const { api, el } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  api.progress({ job: 'import:1', phase: 'indexing', done: 1, total: 4 });
  assert.match(el('dictstatus').textContent, /indexing — 25%/);
});

test('a progress update is written into the bar, not a new one', () => {
  // The bug this pins: the list was rebuilt on every progress event, so the
  // bar was a NEW element each time — and a CSS animation restarts from the
  // beginning when its element is replaced. A download reports many times a
  // second, so the row queued behind it sat frozen at the left edge instead of
  // sliding. Same trick as the renderer suite: tag the live element, and see
  // whether it survived. (ARCHITECTURE §5 — do not rebuild what you can write
  // into.)
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  api.progress({ job: 'Jitendex', phase: 'downloading', got: 1, total: 10 });
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  bar.marked = 'x';
  assert.match(bar.text, /downloading 10%/);

  api.progress({ job: 'Jitendex', phase: 'downloading', got: 6, total: 10 });
  const after = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.strictEqual(after.marked, 'x', 'the same bar, updated in place');
  assert.match(after.text, /downloading 60%/, 'and it says the new number');
  assert.strictEqual(after.withClass('fill')[0].style.width, '60%');
});

test('a bar that becomes measurable stops sliding', () => {
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  api.progress({ job: 'Jitendex', phase: 'queued' });
  const bar = rowFor(host, 'Jitendex').withClass('prog')[0];
  assert.ok(bar.withClass('fill')[0].className.includes('indeterminate'));
  api.progress({ job: 'Jitendex', phase: 'indexing', done: 2, total: 4 });
  const fill = rowFor(host, 'Jitendex').withClass('prog')[0].withClass('fill')[0];
  assert.ok(!fill.className.includes('indeterminate'), 'the animation is dropped');
  assert.strictEqual(fill.style.width, '50%');
});

test('progress finds the right row, whatever was clicked last', () => {
  // With a queue, an event can belong to a job the window did not just start.
  const { api, host } = load(fresh());
  api.render(CATALOGUE, INSTALLED);
  api.progress({ job: '明鏡', phase: 'pruning', done: 2, total: 4 });
  assert.match(rowFor(host, '明鏡').withClass('prog')[0].text, /removing 50%/);
  assert.strictEqual(rowFor(host, 'Jitendex').withClass('prog').length, 0);
  api.progress({ job: '明鏡', phase: 'done', labels: ['Jitendex'] });
  assert.strictEqual(api.jobs().size, 0, 'a finished job stops being drawn');
});
