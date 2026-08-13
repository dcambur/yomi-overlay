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

function save(next) {
  cached = { ...load(), ...next };
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
  CONFIG_PATH, DEFAULT_DICTIONARIES, DEFAULT_TRIGGER,
};
