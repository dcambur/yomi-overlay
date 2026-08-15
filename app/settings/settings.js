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
//   wiring              footer buttons, progress events, first load
//
// Nothing here touches the filesystem or the index: every action is a request
// to the main process, which owns both.

// --- state ------------------------------------------------------------------

let config = null;        // the whole saved config, edited in place until Save
let windows = [];         // the last window list from the main process
let selected = null;      // the target being chosen: {bundle, windowId, label}
const expanded = new Set(); // bundles opened to pin one of their windows
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

const PANELS = { window: 'p-window', dicts: 'p-dicts', trigger: 'p-trigger' };

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

/** The windows of one app, grouped under its bundle id. */
function byBundle(list) {
  const groups = new Map();
  for (const w of list) {
    if (!groups.has(w.bundle)) groups.set(w.bundle, []);
    groups.get(w.bundle).push(w);
  }
  return groups;
}

/** One app: any of its windows, with the option to expand and pin one. */
function appRow(bundle, ws) {
  // Liveness per app: green if any window is on the ACTIVE Space; amber if the
  // app is running but parked elsewhere (fullscreen on another desktop,
  // hidden) — the window server cannot see other Spaces' visibility, so
  // "gray = dead" was simply wrong for those targets.
  const anyLive = ws.some((w) => w.onScreen);
  const biggest = ws.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const sub = ws.length === 1
    ? (ws[0].title || '(untitled)')
    : ws.length + ' windows — click to ' + (expanded.has(bundle) ? 'collapse' : 'expand');

  const el = document.createElement('div');
  el.className = 'win';
  if (selected.bundle === bundle && !selected.windowId) el.classList.add('sel');
  el.innerHTML =
    `<span class="dot ${anyLive ? 'live' : 'away'}" title="${anyLive
      ? 'visible on this Space' : 'running — on another Space or hidden'}"></span>`
    + '<span class="grow">'
    + `<div class="app">${esc(ws[0].app)}</div>`
    + `<div class="title">${esc(sub)}</div>`
    + '</span>'
    + `<span class="meta">${biggest.width}×${biggest.height}</span>`;

  el.onclick = () => {
    selected = { bundle, windowId: null, label: ws[0].app };
    // Toggle. Clicking an expanded app used to re-add it to the set, so once
    // opened it could never be closed.
    if (ws.length > 1) {
      if (expanded.has(bundle)) expanded.delete(bundle);
      else expanded.add(bundle);
    }
    renderWindows();
    $('status').textContent = 'target: ' + ws[0].app + ' (any window)';
  };
  return el;
}

/** One window of an expanded app, indented under it. */
function windowRow(bundle, w, appName) {
  const el = document.createElement('div');
  el.className = 'win subwin';
  if (selected.windowId === w.id) el.classList.add('sel');
  el.innerHTML =
    `<span class="dot ${w.onScreen ? 'live' : 'away'}"></span>`
    + `<span class="grow"><div class="title">${esc(w.title || '(untitled)')}</div></span>`
    + `<span class="meta">${w.width}×${w.height}</span>`;
  el.onclick = (ev) => {
    ev.stopPropagation();
    selected = { bundle, windowId: w.id, label: appName + ' — ' + (w.title || 'window') };
    renderWindows();
    $('status').textContent = 'target: ' + selected.label + ' (pinned window)';
  };
  return el;
}

function renderWindows() {
  const host = $('winlist');
  host.innerHTML = '';
  for (const [bundle, ws] of byBundle(windows)) {
    // A pinned window keeps its app expanded so the pin stays visible.
    if (selected.windowId && ws.some((w) => w.id === selected.windowId)) {
      expanded.add(bundle);
    }
    host.appendChild(appRow(bundle, ws));
    if (ws.length > 1 && expanded.has(bundle)) {
      for (const w of ws) host.appendChild(windowRow(bundle, w, ws[0].app));
    }
  }
}

// --- lookup trigger ---------------------------------------------------------

const DEFAULT_TRIGGER = { mode: 'hold', modifier: 'shift', hoverDelayMs: 250 };

function renderTrigger() {
  const t = config.trigger || DEFAULT_TRIGGER;
  $('mode').value = t.mode || DEFAULT_TRIGGER.mode;
  $('modifier').value = t.modifier || DEFAULT_TRIGGER.modifier;
  $('delay').value = t.hoverDelayMs ?? DEFAULT_TRIGGER.hoverDelayMs;
  syncTriggerRows();
}

/** Save the trigger as it changes; nothing here needs the overlay restarting. */
function saveTrigger() {
  window.settings.saveTrigger(currentTrigger());
  $('status').textContent = 'saved';
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
  window.settings.saveDictionaries(config.dictionaries);
  $('dictstatus').textContent = 'saved';
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
  const r = await fn();
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

// --- wiring -----------------------------------------------------------------

for (const id of ['mode', 'modifier', 'delay']) {
  $(id).onchange = () => { syncTriggerRows(); saveTrigger(); };
}
// Nothing blocks an import: pick as many archives as you like, whenever. Each
// gets its own key so they queue behind each other rather than colliding.
$('import').onclick = () => {
  const job = IMPORT + (++importSeq);
  dictAction(job, () => window.settings.dictImport(job));
};
$('close').onclick = () => window.settings.close();
$('save').onclick = async () => {
  $('status').textContent = 'applying…';
  // Only the target: the other two tabs have already saved themselves.
  await window.settings.saveConfig({ target: selected });
  $('status').textContent = 'now watching ' + (selected.label || 'the chosen window');
};

// Every progress event names the job it belongs to, because with a queue the
// window can no longer assume that whatever is happening is the thing it last
// clicked. A job with a row shows its state on that row; anything else — a
// rebuild the main process started on its own — goes to the status line.
window.settings.onDictProgress((p) => {
  if (p.job) {
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
  } else if (p.job) {
    // The row is showing the detail; the line just says how much is behind it.
    const rest = dictJobs.size - 1;
    $('dictstatus').textContent = rest > 0 ? `${rest} more waiting` : '';
  } else if (p.phase === 'downloading') {
    const of = p.total ? ' / ' + inMB(p.total) : '';
    $('dictstatus').textContent = `downloading ${p.name} ${inMB(p.got)}${of} MB`;
  } else if (p.phase === 'indexing') {
    const at = p.total ? ` (${p.done || 0}/${p.total})` : '';
    $('dictstatus').textContent = `indexing ${p.name || ''}${at}${shown}`;
  } else if (p.phase === 'pruning') {
    $('dictstatus').textContent = `removing: ${p.step}${shown}`;
  } else {
    $('dictstatus').textContent = what;
  }
});

// The window list tracks reality on its own — no manual refresh. 2s is far
// below human window-shuffling speed and the scan is ~50ms of CGWindowList.
setInterval(() => { refreshWindows(true).catch(() => {}); }, 2000);

async function init() {
  config = await window.settings.getConfig();
  selected = { ...(config.target || {}) };
  renderTrigger();
  showTab('window');
  await refreshDictionaries();
  await refreshWindows();
}

init();
