// The settings window: target window, lookup trigger, dictionaries.
//
// A classic script, not a module — the same arrangement app/renderer uses, and
// what lets the page load it under script-src 'self'. Everything outside the
// page comes through window.settings, the preload bridge (app/preload/settings.js).
//
// Layout of this file, and of the window itself:
//
//   state and helpers
//   tabs                the three panels
//   target window       what the overlay attaches to
//   lookup trigger      what makes a lookup fire
//   dictionaries        what is installed, in what order
//   anki                where a card goes, and whether the popup offers one
//   wiring              footer buttons, progress events, first load
//
// Nothing here touches the filesystem or the index: every action is a request
// to the main process, which owns both.

// --- state ------------------------------------------------------------------

let config = null;        // the whole saved config, edited in place until Save
let windows = [];         // the last window list from the main process
// The target being chosen: {bundle, app, windowId, label}. `app` is set in
// place of `bundle` for an app that has no bundle id (a CrossOver .exe is a
// bare executable); yomi follows it by that name.
let selected = null;
const expanded = new Set(); // apps opened to pin one of their windows
let lastWinJson = '';     // last rendered window list, to suppress no-op redraws

let lastCatalogue = [];   // dictionaries we can fetch
let lastInstalled = [];   // dictionaries present on disk
// Job keys for imports. An import has no row — the dictionary is not in the
// list until the archive has been read — and each one needs a key of its own,
// or the second is mistaken for the first still running and refused. Which is
// what happened: importing blocked after the first file.
const IMPORT = 'import:';
const isImport = (job) => typeof job === 'string' && job.startsWith(IMPORT);
let importSeq = 0;

// The progress bar drawn for each job, so an update can be written into the
// one on screen instead of replacing it. Rebuilt with the list.
const bars = new Map();

// What the main process is doing, keyed by the row it belongs to. A map and
// not a single value: work is queued there, so more than one dictionary can be
// waiting, and the window must be able to say which.
const dictJobs = new Map();

// --- helpers ----------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/** Bytes as the number a person reads: "38.4 MB" is 38.4, not 40265318. */
const MB = 1024 * 1024;
const inMB = (bytes) => (bytes / MB).toFixed(1);

/**
 * A progress payload as something to show: what is happening, and how far.
 *
 * `pct` is null when the step cannot be measured — the popup draws a moving
 * bar rather than inventing a number. One function because the row and the
 * status line used to each carry their own copy of this arithmetic, and one
 * copy had an off-by-one that reported every step as finished the moment it
 * started.
 */
function progressOf(p) {
  const of = (done, total) => (total ? Math.round(100 * done / total) : null);
  switch (p.phase) {
    // Asked for, but something else is using the index first.
    case 'queued': return { what: 'waiting…', pct: null };
    // `done` counts units that have FINISHED. Nothing is added to it: a step
    // that has just begun is 0%, not 1 of 1.
    case 'downloading': return { what: 'downloading', pct: of(p.got, p.total) };
    case 'indexing': return { what: 'indexing', pct: of(p.done || 0, p.total) };
    case 'pruning': return { what: 'removing', pct: of(p.done || 0, p.total) };
    default: return { what: p.phase || '', pct: null };
  }
}

// --- tabs -------------------------------------------------------------------

const PANELS = { window: 'p-window', dicts: 'p-dicts', trigger: 'p-trigger', anki: 'p-anki' };

/**
 * Show the tab, and the footer button only where it means something.
 *
 * The target window and the trigger are baked into the capture child's
 * arguments, so changing them restarts it — that is what the button is for.
 * Dictionaries save themselves the moment they change (saveDictionaryOrder),
 * so on that tab the button had nothing to apply and no way to say so.
 */
function showTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('on', t.dataset.tab === name);
  }
  for (const [tab, id] of Object.entries(PANELS)) {
    $(id).classList.toggle('on', tab === name);
  }
  // Only the target window needs applying: it is baked into the capture
  // child's arguments, so changing it restarts capture and drops the glyph
  // layer. The trigger and the dictionaries save themselves as they change.
  $('save').classList.toggle('hidden', name !== 'window');
  // Anki is asked when its tab is looked at, not on a timer: a deck list
  // changes at human speed, and a closed Anki would otherwise be asked every
  // few seconds for as long as the window is open.
  if (name === 'anki') refreshAnki();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => showTab(tab.dataset.tab);
}

// --- target window ----------------------------------------------------------

async function refreshWindows(auto) {
  if (!auto) $('status').textContent = 'scanning windows…';
  const ws = await window.settings.listWindows();
  // Auto-refresh must not flicker the list (or eat a click mid-render):
  // re-render only when something actually changed.
  const j = JSON.stringify(ws);
  if (auto && j === lastWinJson) return;
  lastWinJson = j;
  windows = ws;
  renderWindows();
  if (!auto) $('status').textContent = windows.length + ' windows';
}

/**
 * How a window's app is named to yomi: by bundle id, or by the name on its
 * Dock tile when it has none — the same fallback --list-all reports.
 */
const identity = (w) =>
  (w.bundle ? { bundle: w.bundle, app: null } : { bundle: null, app: w.app });
const keyOf = (t) => t.bundle || t.app;

/** The windows of one app, grouped under its identity. */
function byApp(list) {
  const groups = new Map();
  for (const w of list) {
    const key = keyOf(w);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  return groups;
}

/** One app: any of its windows, with the option to expand and pin one. */
function appRow(key, ws) {
  // Liveness per app: green if any window is on the ACTIVE Space; amber if the
  // app is running but parked elsewhere (fullscreen on another desktop,
  // hidden) — the window server cannot see other Spaces' visibility, so
  // "gray = dead" was simply wrong for those targets.
  const anyLive = ws.some((w) => w.onScreen);
  const biggest = ws.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const sub = ws.length === 1
    ? (ws[0].title || '(untitled)')
    : ws.length + ' windows — click to ' + (expanded.has(key) ? 'collapse' : 'expand');

  const el = document.createElement('div');
  el.className = 'win';
  if (keyOf(selected) === key && !selected.windowId) el.classList.add('sel');
  el.innerHTML =
    `<span class="dot ${anyLive ? 'live' : 'away'}" title="${anyLive
      ? 'visible on this Space' : 'running — on another Space or hidden'}"></span>`
    + '<span class="grow">'
    + `<div class="app">${esc(ws[0].app)}</div>`
    + `<div class="title">${esc(sub)}</div>`
    + '</span>'
    + `<span class="meta">${biggest.width}×${biggest.height}</span>`;

  el.onclick = () => {
    selected = { ...identity(ws[0]), windowId: null, label: ws[0].app };
    // Toggle. Clicking an expanded app used to re-add it to the set, so once
    // opened it could never be closed.
    if (ws.length > 1) {
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
    }
    renderWindows();
    $('status').textContent = 'target: ' + ws[0].app + ' (any window)';
  };
  return el;
}

/** One window of an expanded app, indented under it. */
function windowRow(w, appName) {
  const el = document.createElement('div');
  el.className = 'win subwin';
  if (selected.windowId === w.id) el.classList.add('sel');
  el.innerHTML =
    `<span class="dot ${w.onScreen ? 'live' : 'away'}"></span>`
    + `<span class="grow"><div class="title">${esc(w.title || '(untitled)')}</div></span>`
    + `<span class="meta">${w.width}×${w.height}</span>`;
  el.onclick = (ev) => {
    ev.stopPropagation();
    const label = appName + ' — ' + (w.title || 'window');
    selected = { ...identity(w), windowId: w.id, label };
    renderWindows();
    $('status').textContent = 'target: ' + selected.label + ' (pinned window)';
  };
  return el;
}

function renderWindows() {
  const host = $('winlist');
  host.innerHTML = '';
  for (const [key, ws] of byApp(windows)) {
    // A pinned window keeps its app expanded so the pin stays visible.
    if (selected.windowId && ws.some((w) => w.id === selected.windowId)) {
      expanded.add(key);
    }
    host.appendChild(appRow(key, ws));
    if (ws.length > 1 && expanded.has(key)) {
      for (const w of ws) host.appendChild(windowRow(w, ws[0].app));
    }
  }
}

// --- lookup trigger ---------------------------------------------------------

const DEFAULT_TRIGGER = { mode: 'hold', modifier: 'shift', hoverDelayMs: 250 };

function renderTrigger() {
  $('images').checked = config.images !== false;
  const t = config.trigger || DEFAULT_TRIGGER;
  $('mode').value = t.mode || DEFAULT_TRIGGER.mode;
  $('modifier').value = t.modifier || DEFAULT_TRIGGER.modifier;
  $('delay').value = t.hoverDelayMs ?? DEFAULT_TRIGGER.hoverDelayMs;
  syncTriggerRows();
}

/**
 * Say what became of a save once main has answered. Printing "saved" before
 * the answer said so for saves main refused, and a refused footer Save sat on
 * "applying…" for good.
 */
async function report(save, line = 'status', done = 'saved') {
  try {
    await save;
    $(line).textContent = done;
  } catch (e) {
    $(line).textContent = 'not saved — ' + e.message;
  }
}

/** Save the trigger as it changes; nothing here needs the overlay restarting. */
function saveTrigger() {
  report(window.settings.saveTrigger(currentTrigger()));
}

/** Only show the setting that applies to the chosen mode. */
function syncTriggerRows() {
  const hover = $('mode').value === 'hover';
  $('row-mod').classList.toggle('hidden', hover);
  $('row-delay').classList.toggle('hidden', !hover);
}

function currentTrigger() {
  const delay = parseInt($('delay').value, 10) || DEFAULT_TRIGGER.hoverDelayMs;
  return {
    mode: $('mode').value,
    modifier: $('modifier').value,
    // The input carries min/max, but a typed value can still be anything.
    hoverDelayMs: Math.min(2000, Math.max(50, delay)),
  };
}

// --- dictionaries -----------------------------------------------------------
//
// Two groups, split by STATE: what the index holds, and what can still be
// fetched. Every row in the first has a checkbox, arrows and Remove; every row
// in the second has Download and nothing else. One kind of row per group,
// which is what the single mixed list got wrong.
//
// Splitting them the other way — the ones we offer vs the ones you brought —
// looks tidier and breaks the arrows: priority is ONE list across every
// dictionary, so a swap that crosses a group boundary cannot move a row. The
// order you see has to be the order that is saved, and that only holds if
// everything installed is in one group. Where a dictionary came from is on its
// row anyway.
//
// Rows are keyed on the LABEL the index uses, never on the archive's own title.
// Keying on the title showed 明鏡 twice — once from the manifest and once from
// the file — with a different button on each.

/**
 * Write the priority list and the on/off flags, now.
 *
 * These are live: the main process saves them without restarting anything, and
 * lookup.js re-reads the order per lookup. The footer button is for the target
 * window and the trigger, which DO need the capture child restarting — having
 * one button mean "apply" for some tabs and nothing for others was the
 * ambiguity, not the button.
 */
function saveDictionaryOrder() {
  report(window.settings.saveDictionaries(config.dictionaries), 'dictstatus');
}

async function refreshDictionaries() {
  [lastCatalogue, lastInstalled] = await Promise.all([
    window.settings.dictCatalogue(), window.settings.dictInstalled(),
  ]);
  config = await window.settings.getConfig();
  renderDictionaries();
}

/**
 * Ask for one install/import/removal. It happens in turn.
 *
 * Nothing is blocked while another job runs: the main process queues them
 * because they all write one index, and refusing the click was the old way of
 * saying so — which left "Import a .zip you own…" looking clickable and doing
 * nothing. Only the row that already has a job outstanding is inert.
 */
async function dictAction(label, fn) {
  if (dictJobs.has(label)) return;
  dictJobs.set(label, { phase: 'starting' });
  renderDictionaries();
  // A request that rejects is still an answer. Without this the row stayed
  // busy for as long as the window was open, and nothing said what failed.
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, error: e.message }; }
  dictJobs.delete(label);
  await refreshDictionaries();
  // An import of several archives can half-succeed: some went in, one was not
  // a dictionary. Say so, rather than reporting the whole thing as a failure
  // or silently swallowing the part that did not work.
  if (r && r.failed && r.failed.length) {
    $('dictstatus').textContent = `could not read ${r.failed.map((f) => f.file).join(', ')}`;
  } else if (r && r.ok === false && !r.cancelled) {
    $('dictstatus').textContent = 'failed: ' + r.error;
  } else {
    $('dictstatus').textContent = '';
  }
}

/**
 * A row's progress, as a bar and a number, beside the button that started it.
 *
 * Returns the parts as well as the element, so an update can be written into
 * the pieces directly rather than found again.
 */
function progressBar(p) {
  const text = document.createElement('span');
  text.className = 'pct';

  const fill = document.createElement('span');

  const bar = document.createElement('span');
  bar.className = 'bar';
  bar.appendChild(fill);

  const wrap = document.createElement('span');
  wrap.className = 'prog';
  wrap.appendChild(text);
  wrap.appendChild(bar);

  const parts = { wrap, text, fill };
  paintProgress(parts, p);
  return parts;
}

/**
 * Write a progress payload into a bar that already exists.
 *
 * Separate from building one because REBUILDING it is the bug: an unmeasurable
 * step is drawn as a sliding fill, and a CSS animation restarts from the
 * beginning every time its element is replaced. A download reports many times
 * a second, so the row behind it redrew that fast and its "waiting…" bar sat
 * frozen at the left edge, never sliding. The determinate bars had the same
 * problem more quietly: their width transition never got to run either.
 *
 * Same lesson as the glyph layer (ARCHITECTURE §5) — do not rebuild what you
 * can write into.
 */
function paintProgress({ text, fill }, p) {
  const { what, pct } = progressOf(p);
  text.textContent = pct === null ? what : `${what} ${pct}%`;
  fill.className = 'fill' + (pct === null ? ' indeterminate' : '');
  fill.style.width = pct === null ? '' : pct + '%';
}

/** The enable/disable checkbox, for a dictionary that is in the index. */
function enableBox(cfg) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!cfg.enabled;
  cb.disabled = dictJobs.has(cfg.name);
  cb.onchange = () => {
    cfg.enabled = cb.checked;
    saveDictionaryOrder();
    renderDictionaries();
  };
  return cb;
}

/**
 * Up/down, for a dictionary that is in the index. Priority is sense order:
 * which dictionary's definition the popup shows first.
 *
 * `shown` is every installed dictionary in the order the window is drawing
 * them, and a press swaps with the neighbour IN THAT ORDER — not with the
 * neighbour in the saved list. The two differ whenever a downloadable-but-
 * absent dictionary sits between two installed ones, and swapping in the saved
 * list then moved nothing the eye could follow. Which is the whole bug: the
 * arrows worked, and looked broken.
 */
function priorityButtons(label, shown) {
  const move = document.createElement('span');
  move.className = 'move';
  const at = shown.indexOf(label);
  // Every installed dictionary can be reordered — which one provides a sense
  // first is a property of all of them, not of a chosen few.
  for (const [glyph, delta] of [['▲', -1], ['▼', 1]]) {
    const b = document.createElement('button');
    b.textContent = glyph;
    const neighbour = shown[at + delta];
    b.disabled = dictJobs.size > 0 || neighbour === undefined;
    b.onclick = () => {
      const list = config.dictionaries;
      const i = list.findIndex((d) => d.name === label);
      const j = list.findIndex((d) => d.name === neighbour);
      if (i < 0 || j < 0) return;
      [list[i], list[j]] = [list[j], list[i]];
      saveDictionaryOrder();
      renderDictionaries();
    };
    move.appendChild(b);
  }
  return move;
}

/** The second line of a row: what the dictionary is, or what it would be. */
function dictionaryDetail(entry, indexed) {
  const { label, detail, info } = entry;
  if (!info) return detail || '';
  const named = info.title && info.title !== label ? ` · ${info.title}` : '';
  // On disk, and the index has no rows for it. Say so: without a word for it,
  // the row simply loses its checkbox and its arrows, which reads as a
  // dictionary that failed rather than one the index has not caught up with.
  const orphan = indexed ? '' : ' · not in the index — remove and import it again';
  return `${info.kind || 'unreadable'} · ${inMB(info.size)} MB${named}${orphan}`;
}

/** One dictionary. `entry` carries whichever of catalogue/installed applies. */
function dictionaryRow(entry, shown) {
  const { label, name, info, catalogueId } = entry;
  const idx = config.dictionaries.findIndex((d) => d.name === label);
  const cfg = idx >= 0 ? config.dictionaries[idx] : null;
  // In the index, not merely on disk: only then is there an order to change or
  // an enabled flag to set.
  const indexed = !!(info && cfg);

  const el = document.createElement('div');
  el.className = 'dict' + (cfg && !cfg.enabled ? ' off' : '')
    + (info && !cfg ? ' orphan' : '');

  // Left to right: on/off, then priority, then what it is, then its one action.
  // The checkbox leads because it answers the first question about a row — is
  // this dictionary being consulted at all — and priority only means anything
  // for the ones that are.
  const cb = indexed ? enableBox(cfg) : document.createElement('span');
  el.appendChild(cb);
  el.appendChild(indexed ? priorityButtons(label, shown)
                         : document.createElement('span'));

  // The name is still a label for the checkbox, so clicking the text toggles
  // it — the checkbox is no longer inside the label, so it needs saying.
  const mid = document.createElement('label');
  mid.className = 'grow';
  if (indexed) {
    cb.id = 'enable-' + idx;
    mid.htmlFor = cb.id;
  }
  const txt = document.createElement('span');
  txt.innerHTML = `<div class="app">${esc(name)}</div>`
    + `<div class="title">${esc(dictionaryDetail(entry, indexed))}</div>`;
  mid.appendChild(txt);
  el.appendChild(mid);

  // Right: progress while this row has work outstanding, then its one action.
  const job = dictJobs.get(label);
  if (job) {
    const parts = progressBar(job);
    bars.set(label, parts);
    el.appendChild(parts.wrap);
  }
  const act = document.createElement('button');
  // Only this row waits on this row. Anything else can still be asked for.
  act.disabled = !!job;
  if (info) {
    act.textContent = 'Remove';
    act.onclick = () => dictAction(label, () => window.settings.dictRemove(info.file));
  } else {
    act.textContent = 'Download';
    act.onclick = () => dictAction(label, () => window.settings.dictDownload(catalogueId));
  }
  el.appendChild(act);
  return el;
}

function group(host, title, rows, shown) {
  if (!rows.length) return;
  const h = document.createElement('p');
  h.className = 'hint group-head';
  h.textContent = title;
  host.appendChild(h);
  for (const r of rows) host.appendChild(dictionaryRow(r, shown));
}

function renderDictionaries() {
  const host = $('dictlist');
  host.innerHTML = '';
  bars.clear();

  const byCatalogue = new Map(lastCatalogue.map((c) => [c.label, c]));
  // Priority is the position in the saved list; anything the index does not
  // hold has none.
  const priority = (label) => {
    const i = config.dictionaries.findIndex((d) => d.name === label);
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
  };

  const installed = lastInstalled
    .map((d) => ({
      label: d.label,
      // What we call it in the catalogue, if we know it — "JPDB frequency"
      // reads better than the bare label the index uses.
      name: (byCatalogue.get(d.label) || {}).name || d.name,
      info: d,
    }))
    .sort((a, b) => priority(a.label) - priority(b.label));

  const have = new Set(lastInstalled.map((d) => d.label));
  const available = lastCatalogue
    .filter((c) => !have.has(c.label))
    .map((c) => ({ label: c.label, name: c.name, detail: c.detail, catalogueId: c.id }));

  // The installed rows, top to bottom as this window draws them — which is the
  // priority order, so an arrow moves a row to where it looks like it should go.
  const shown = installed.filter((r) => priority(r.label) < Number.MAX_SAFE_INTEGER)
    .map((r) => r.label);

  group(host, 'Installed — asked in this order', installed, shown);
  group(host, 'Available — freely licensed, downloaded here', available, shown);
  if (!installed.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No dictionary yet — download one above, or import a .zip you own.';
    host.appendChild(p);
  }
}

// --- anki -------------------------------------------------------------------
//
// Saved as it changes, like the trigger: the overlay draws its card marks from
// the moment Anki is on and stops when it is off. The deck list is what Anki
// reports when the tab is shown; with Anki closed the chosen deck is still
// listed, alone, so the choice can be seen and is not lost.

const DEFAULT_ANKI = { enabled: false, deck: null, tags: ['yomi-overlay'], picture: true };
let ankiStatus = null;    // the last answer from the main process, or null

/** The saved Anki settings, filled in for a config written before they existed. */
function ankiConfig() {
  config.anki = { ...DEFAULT_ANKI, ...(config.anki || {}) };
  return config.anki;
}

function saveAnki() {
  report(window.settings.saveAnki(ankiConfig()));
}

function renderAnki() {
  const a = ankiConfig();
  $('anki-on').checked = !!a.enabled;
  $('anki-tags').value = (a.tags || []).join(' ');
  $('anki-picture').checked = a.picture !== false;
  renderAnkiStatus();
  renderDecks();
}

/**
 * The status row, in the window picker's dot vocabulary: green is ready,
 * amber is running but missing something, grey is not there. The state is
 * a word or two; the detail is what to do about it, and is empty when there
 * is nothing to do — a ready Anki does not need its requirements listed.
 */
function renderAnkiStatus() {
  const s = ankiStatus;
  let cls = 'idle', state = 'not checked yet', detail = '';
  if (s && s.running && s.model) {
    cls = 'live';
    state = 'Ready';
    const n = (s.decks || []).length;
    detail = `Lapis note type · ${n} ${n === 1 ? 'deck' : 'decks'}`;
  } else if (s && s.running) {
    cls = 'away';
    state = 'No Lapis';
    detail = 'import the note type from github.com/donkuri/lapis';
  } else if (s) {
    // Connection refused is the common case and has a plain reading; any
    // other failure (a timeout, a 403 from a locked AnkiConnect) is shown as
    // the client reported it, because that is the only clue there is.
    const refused = /not running/.test(s.error || '');
    state = refused ? 'Not running' : 'Not answering';
    detail = refused
      ? 'open Anki with AnkiConnect'
      : (s.error || '');
  }
  $('anki-dot').className = 'dot ' + cls;
  $('anki-state').textContent = state;
  $('anki-detail').textContent = detail;
}

async function refreshAnki() {
  $('anki-state').textContent = 'checking…';
  $('anki-detail').textContent = '';
  // main/anki.js answers every case itself, so a rejection here is the
  // bridge, not Anki — a main process older than this page, most likely
  // (measured 2026-09-19: "No handler registered for 'anki:status'", and the
  // row said "checking…" until the window was closed). Shown as the not-
  // answering state rather than left hanging.
  try {
    ankiStatus = await window.settings.ankiStatus();
  } catch (e) {
    ankiStatus = { running: false, error: e.message };
  }
  renderAnkiStatus();
  renderDecks();
}

// Anki names a subdeck by its path, `Parent::Child`, and deckNames lists
// every level. Drawn flat, a collection with a few nested decks is a wall of
// repeated prefixes (this machine: 18 decks, 3 roots). So the list is the
// tree Anki's own deck browser shows: a parent folds its subdecks, and the
// folds start closed except along the path to the chosen deck. Which folds
// are open lives here, not in config — it is how the list looks right now,
// not a setting.
const openDecks = new Set();
let openDecksSeeded = false;

/** The deck list as a tree: [{ name, path, kids: [...] }], in Anki's order. */
function deckTree(names) {
  const roots = [];
  const byPath = new Map();
  for (const path of names) {
    const parts = path.split('::');
    let level = roots, prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}::${part}` : part;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name: part, path: prefix, kids: [] };
        byPath.set(prefix, node);
        level.push(node);
      }
      level = node.kids;
    }
  }
  return roots;
}

/** Every proper ancestor of a deck path, nearest last. */
function ancestors(path) {
  const parts = (path || '').split('::');
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('::'));
  return out;
}

/**
 * One deck, and its subdecks under it. The name chooses; the fold at the
 * left opens and closes, and is drawn (blank) on a leaf too, so names line
 * up down a level. A closed parent says how many it hides, and keeps the
 * accent when the chosen deck is one of them, so a choice is never hidden.
 */
function deckNode(node, chosen) {
  const el = document.createElement('div');
  el.className = 'deck-node';
  const open = openDecks.has(node.path);
  const hasKids = node.kids.length > 0;
  const chosenInside = !open && ancestors(chosen).includes(node.path);
  const row = document.createElement('div');
  row.className = 'deck' + (node.path === chosen ? ' sel' : '')
    + (chosenInside ? ' holds-sel' : '');
  row.dataset.path = node.path;
  const fold = document.createElement('button');
  fold.className = 'fold' + (hasKids ? (open ? ' open' : '') : ' leaf');
  fold.type = 'button';
  fold.title = hasKids ? (open ? 'Fold the subdecks away' : 'Show the subdecks') : '';
  fold.tabIndex = hasKids ? 0 : -1;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = node.name;
  row.append(fold, name);
  if (hasKids && !open) {
    const count = document.createElement('span');
    count.className = 'sub';
    const n = node.kids.length;
    count.textContent = `${n} ${n === 1 ? 'subdeck' : 'subdecks'}`;
    row.append(count);
  }
  el.append(row);
  if (hasKids) {
    const kids = document.createElement('div');
    kids.className = 'deck-kids' + (open ? '' : ' hidden');
    for (const k of node.kids) kids.append(deckNode(k, chosen));
    el.append(kids);
  }
  row.onclick = () => {
    ankiConfig().deck = node.path;
    saveAnki();
    renderDecks();
  };
  if (hasKids) {
    fold.onclick = (e) => {
      e.stopPropagation();
      if (open) openDecks.delete(node.path); else openDecks.add(node.path);
      renderDecks();
    };
  }
  return el;
}

function renderDecks() {
  const host = $('decklist');
  host.innerHTML = '';
  const a = ankiConfig();
  const decks = (ankiStatus && ankiStatus.decks) || [];
  // With Anki closed the chosen deck is still listed, alone, so the choice
  // can be seen and is not lost. With Anki open and the deck gone from it,
  // the same: the row is the only place the stale choice is visible.
  const listed = decks.slice();
  if (a.deck && !listed.includes(a.deck)) listed.push(a.deck);
  if (!openDecksSeeded) {
    for (const p of ancestors(a.deck)) openDecks.add(p);
    openDecksSeeded = true;
  }
  for (const node of deckTree(listed)) host.appendChild(deckNode(node, a.deck));
  if (!listed.length) {
    const p = document.createElement('p');
    p.className = 'hint empty';
    p.textContent = 'No decks to show — open Anki and check again.';
    host.appendChild(p);
  }
}

// --- wiring -----------------------------------------------------------------

$('anki-on').onchange = () => {
  ankiConfig().enabled = $('anki-on').checked;
  saveAnki();
};
$('anki-picture').onchange = () => {
  ankiConfig().picture = $('anki-picture').checked;
  saveAnki();
};
$('anki-tags').onchange = () => {
  const tags = $('anki-tags').value.split(/\s+/).filter(Boolean);
  ankiConfig().tags = tags;
  $('anki-tags').value = tags.join(' ');
  saveAnki();
};
$('anki-refresh').onclick = () => refreshAnki();

for (const id of ['mode', 'modifier', 'delay']) {
  $(id).onchange = () => { syncTriggerRows(); saveTrigger(); };
}
// Live, like everything else on this tab: the overlay is told, and the next
// popup is drawn the new way. Nothing is rebuilt and nothing restarts —
// images are read from the archives at the moment they are shown.
$('images').onchange = () => {
  config.images = $('images').checked;
  report(window.settings.saveView({ images: config.images }));
};
// Nothing blocks an import: pick as many archives as you like, whenever. Each
// gets its own key so they queue behind each other rather than colliding.
$('import').onclick = () => {
  const job = IMPORT + (++importSeq);
  dictAction(job, () => window.settings.dictImport(job));
};
$('close').onclick = () => window.settings.close();
$('save').onclick = () => {
  $('status').textContent = 'applying…';
  // Only the target: the other two tabs have already saved themselves.
  return report(window.settings.saveConfig({ target: selected }), 'status',
                'now watching ' + (selected.label || 'the chosen window'));
};

// Every progress event names the job it belongs to (the queue stamps it, and
// it is the only sender), because with a queue the window can no longer
// assume that whatever is happening is the thing it last clicked. A job shows
// its state on its row; the status line says how much is behind it.
window.settings.onDictProgress((p) => {
  const bar = bars.get(p.job);
  if (p.phase === 'done' || p.phase === 'error') {
    dictJobs.delete(p.job);
    renderDictionaries();
  } else {
    dictJobs.set(p.job, p);
    // Write into the bar already on screen; only draw the list again when
    // there is no bar yet — that is, when this job's row is new.
    if (bar) paintProgress(bar, p);
    else renderDictionaries();
  }

  const { what, pct } = progressOf(p);
  const shown = pct === null ? '' : ` — ${pct}%`;
  if (p.phase === 'error') {
    $('dictstatus').textContent = 'failed: ' + p.message;
  } else if (p.phase === 'done') {
    $('dictstatus').textContent = 'ready — ' + (p.labels || []).join(', ');
  } else if (isImport(p.job)) {
    // An import has no row of its own — the dictionary is not in the list
    // until it lands — so its progress belongs beside the button that started
    // it, which is where this line sits.
    $('dictstatus').textContent = `${what}${shown}`;
  } else {
    // The row is showing the detail; the line just says how much is behind it.
    const rest = dictJobs.size - 1;
    $('dictstatus').textContent = rest > 0 ? `${rest} more waiting` : '';
  }
});

// The window list tracks reality on its own — no manual refresh — while it is
// on screen. 2s is far below human window-shuffling speed and the scan is ~50ms
// of CGWindowList, but each one is a process spawn, and a list nobody is
// looking at needs none.
setInterval(() => {
  if ($('p-window').classList.contains('on')) refreshWindows(true).catch(() => {});
}, 2000);

async function init() {
  config = await window.settings.getConfig();
  selected = { ...(config.target || {}) };
  renderTrigger();
  renderAnki();
  showTab('window');
  await refreshDictionaries();
  await refreshWindows();
}

init();
