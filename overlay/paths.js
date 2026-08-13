// Where everything lives. One file knows the layout; nothing else does.
//
// Data lives outside the app bundle: the dictionary index alone is ~370 MB and
// the dictionaries another ~100 MB, none of which should be duplicated into a
// packaged .app on every rebuild. The bundle lives in /Applications while the
// data stays with the project, so these must be absolute — but they are
// *derived*, not written down. A literal path only ever describes one machine,
// and a clone on any other one failed at spawn() with ENOENT.
//
// __dirname is this file's own directory, which IS the app directory: the
// bundle contains only shell/bootstrap.js, so whatever loaded main.js loaded it
// from the project (see shell/bootstrap.js). YOMI_OVERLAY_DIR is what bootstrap
// resolved and re-exported; honouring it first keeps a deliberate override
// (a second checkout, a test rig) working.
//
// *** Keep this file beside the entry main.js. *** APP_DIR's fallback is
// __dirname, so moving paths.js into a subdirectory without changing that
// fallback would silently shift every other root by one level — and the
// env-var path would keep working, so it would break only on the override
// path nobody tests.
//
// The roots below are all distinct IDEAS that happen to share directories
// today. They were one constant (`DATA_DIR`) until the layout needed to
// change, at which point "the code lives where the data lives" turned out to
// be seven independent facts wearing one name. Splitting them is what lets the
// directory layout move without touching any consumer.

const path = require('path');

/** The JS the bundle loads. The directory bootstrap.js found `main.js` in. */
const APP_DIR = process.env.YOMI_OVERLAY_DIR || __dirname;

/** The checkout. Everything else is derived from this or from APP_DIR. */
const PROJECT_ROOT = path.resolve(APP_DIR, '..');

/** Overlay window: index.html and its scripts. */
const RENDERER_DIR = APP_DIR;

/** Settings window: settings.html and its script. */
const SETTINGS_DIR = APP_DIR;

/** Preload scripts — the entire trust boundary between renderer and Node. */
const PRELOAD_DIR = APP_DIR;

/** Tray icons and other bundled image assets. */
const ASSETS_DIR = APP_DIR;

/** Generated + user data: index.db, dictionaries.json, config.json, dicts/. */
const DATA_DIR = APP_DIR;

/** Build/side scripts and the Python venv the tier-2 sidecar runs in. */
const TOOLS_DIR = APP_DIR;

/** Compiled helpers. */
const BIN_DIR = PROJECT_ROOT;

/** The capture helper. Spawn failures here are reported by name in main.js. */
const OCR_BIN = path.join(BIN_DIR, 'kindleocr');

module.exports = {
  PROJECT_ROOT, APP_DIR, RENDERER_DIR, SETTINGS_DIR, PRELOAD_DIR,
  ASSETS_DIR, DATA_DIR, TOOLS_DIR, BIN_DIR, OCR_BIN,
};
