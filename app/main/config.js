// Persisted settings: which window to attach to, and which dictionaries to
// show and in what order.

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('../paths.js');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const MANIFEST_PATH = path.join(DATA_DIR, 'dictionaries.json');

// Every dictionary the index can contain, in a sensible default order.
// `enabled` and position are both user-editable in the settings window.
const DEFAULT_DICTIONARIES = [
  { name: 'Jitendex', enabled: true },
  { name: '三省堂', enabled: true },
  { name: '明鏡', enabled: true },
  { name: '旺文社', enabled: true },
  { name: '実用', enabled: true },
  { name: 'DOJG', enabled: true },
  { name: 'どんなとき', enabled: true },
  { name: 'Names', enabled: true },
  { name: 'KANJIDIC', enabled: true },
];

// How a lookup is triggered.
//   modifier: which key must be held — Shift collides with shift-click and some
//             IME candidate selection, so it has to be changeable.
//   mode:     'hold'  — modifier + point (Yomitan/10ten muscle memory)
//             'hover' — no key; look up after dwelling on a glyph. Good for
//                       dense scanning, tiring for casual reading; both exist
//                       in Yomitan, so offer both rather than picking for the user.
const DEFAULT_TRIGGER = { modifier: 'shift', mode: 'hold', hoverDelayMs: 250 };

const DEFAULTS = {
  // null target => first run, settings window opens so a window can be picked.
  target: { bundle: 'com.amazon.Lassen', windowId: null, label: 'Amazon Kindle' },
  dictionaries: DEFAULT_DICTIONARIES,
  interval: 0.6,
  trigger: DEFAULT_TRIGGER,
  // Which recognizer yomi uses: 'auto' prefers Live Text (private
  // VisionKit — reads tategaki natively) and degrades to Vision on failure;
  // 'vision' is the one-line revert (INTEGRATION.md Phase 1).
  engine: 'auto',
  // Temporal voting (Phase 2): re-OCR a static page up to `passes` times
  // (every `everyN`th unchanged capture) and majority-vote per character.
  // passes: 1 disables.
  voting: { passes: 3, everyN: 2 },
  // Tier-2 second opinion (Phase 3): manga-ocr sidecar on the looked-up
  // word's region. 'shadow' = log disagreements only (popup unaffected);
  // 'off' disables. The sidecar is lazy and killed after idleKillMin idle.
  tier2: { mode: 'shadow', idleKillMin: 10 },
};

let cached = null;

/**
 * The dictionaries actually present in index.db, in build order.
 *
 * build-index.py writes this alongside the index. The hardcoded list above is
 * only a fallback: relying on it alone meant a dictionary the user dropped into
 * dicts/ was indexed and queryable but absent from the settings window, so it
 * could be neither hidden nor reordered.
 */
function knownDictionaries() {
  try {
    const list = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const names = Array.isArray(list)
      ? list.filter(n => typeof n === 'string' && n.trim())
      : [];
    if (names.length) return names.map(name => ({ name, enabled: true }));
  } catch { /* no manifest yet — an index built before this existed */ }
  return DEFAULT_DICTIONARIES.map(d => ({ ...d }));
}

function load() {
  if (cached) return cached;
  const known = knownDictionaries();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Merge so dictionaries added in a later build still appear.
    const have = new Set((raw.dictionaries || []).map(d => d.name));
    const merged = [...(raw.dictionaries || [])];
    for (const d of known) {
      if (!have.has(d.name)) merged.push({ ...d });
    }
    // Merge trigger too: a config written before this setting existed has no
    // `trigger` key, and spreading `raw` over DEFAULTS would leave it undefined
    // for every consumer rather than falling back.
    cached = { ...DEFAULTS, ...raw, dictionaries: merged,
               trigger: { ...DEFAULT_TRIGGER, ...(raw.trigger || {}) } };
  } catch {
    cached = { ...JSON.parse(JSON.stringify(DEFAULTS)), dictionaries: known };
  }
  return cached;
}


// Values that reach the capture child's argv, clamped where the schema lives.
//
// spawn() is called with an argv ARRAY and no shell, so nothing here can be
// injected into a command line. This is about keeping a malformed setting from
// producing a child that fails in a confusing way — a windowId of "abc"
// becomes --window abc, and yomi exits with a usage error the user then has to
// trace back to a settings field.
//
// Unknown keys pass through untouched: the settings window is allowed to grow
// without this function having to know about it first.
const MODIFIERS = new Set(['shift', 'control', 'option', 'command']);
const MODES = new Set(['hold', 'hover']);
const ENGINES = new Set(['auto', 'vision', 'livetext']);

const num = (v, lo, hi, fallback) =>
  (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) ? v : fallback;

function sanitize(next, current) {
  const out = { ...next };
  if (out.target && typeof out.target === 'object') {
    const t = { ...out.target };
    if (typeof t.bundle !== 'string' || !t.bundle) t.bundle = null;
    t.windowId = Number.isInteger(t.windowId) && t.windowId > 0 ? t.windowId : null;
    if (typeof t.label !== 'string') t.label = t.bundle || 'not set';
    out.target = t;
  }
  if (out.trigger && typeof out.trigger === 'object') {
    const g = { ...out.trigger };
    if (!MODIFIERS.has(g.modifier)) g.modifier = current.trigger.modifier;
    if (!MODES.has(g.mode)) g.mode = current.trigger.mode;
    g.hoverDelayMs = num(g.hoverDelayMs, 50, 2000, current.trigger.hoverDelayMs);
    out.trigger = g;
  }
  if ('engine' in out && !ENGINES.has(out.engine)) out.engine = current.engine;
  if ('interval' in out) out.interval = num(out.interval, 0.1, 10, current.interval);
  if (out.voting && typeof out.voting === 'object') {
    out.voting = {
      passes: num(out.voting.passes, 1, 9, current.voting.passes),
      everyN: num(out.voting.everyN, 1, 60, current.voting.everyN),
    };
  }
  if (Array.isArray(out.dictionaries)) {
    out.dictionaries = out.dictionaries
      .filter((d) => d && typeof d.name === 'string' && d.name)
      .map((d) => ({ name: d.name, enabled: !!d.enabled }));
  }
  return out;
}

function save(next) {
  const current = load();
  cached = { ...current, ...sanitize(next, current) };
  // Write-then-rename: a crash partway through a direct write leaves unparseable
  // JSON, and load() silently falls back to defaults — losing the user's target.
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  return cached;
}

/** Ordered list of enabled dictionary names — the popup's display priority. */
function enabledDictionaries() {
  return load().dictionaries.filter(d => d.enabled).map(d => d.name);
}

/** Arguments selecting the capture target for yomi. */
function targetArgs() {
  const t = load().target || {};
  if (t.windowId) return ['--window', String(t.windowId)];
  if (t.bundle) return ['--bundle', t.bundle];
  return [];
}

/** Trigger settings, always fully populated. */
function trigger() {
  return { ...DEFAULT_TRIGGER, ...(load().trigger || {}) };
}

module.exports = {
  load, save, enabledDictionaries, targetArgs, trigger,
  CONFIG_PATH, DEFAULT_DICTIONARIES, DEFAULT_TRIGGER, sanitize,
};
