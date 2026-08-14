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
const os = require('os');

/** The JS the bundle loads. The directory bootstrap.js found `main.js` in. */
const APP_DIR = process.env.YOMI_OVERLAY_DIR || __dirname;

/** The checkout. Everything else is derived from this or from APP_DIR. */
const PROJECT_ROOT = path.resolve(APP_DIR, '..');

/**
 * True when this code was loaded from INSIDE the .app bundle — a release
 * build, where the app carries its own copy of everything instead of finding
 * a checkout.
 *
 * `process.resourcesPath` exists in both cases (unpackaged, it points at
 * Electron's own Resources), so the test is not "is it set" but "did the code
 * come from there". A developer's app resolves APP_DIR through the pointer
 * file to a checkout and answers false, which is what keeps
 * "restart, don't rebuild" working (ARCHITECTURE §6).
 */
const BUNDLED = !!process.resourcesPath &&
  APP_DIR.startsWith(process.resourcesPath + path.sep);

/** Overlay window: index.html and its scripts. */
const RENDERER_DIR = path.join(APP_DIR, 'renderer');

/** Settings window: settings.html and its script. */
const SETTINGS_DIR = path.join(APP_DIR, 'settings');

/** Preload scripts — the entire trust boundary between renderer and Node. */
const PRELOAD_DIR = path.join(APP_DIR, 'preload');

/** Tray icons and other bundled image assets. */
const ASSETS_DIR = path.join(APP_DIR, 'assets');

/** Generated + user data: index.db, dictionaries.json, config.json, dicts/. */
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

/**
 * Read-only material the app ships with: the dictionary index, its manifest,
 * and the capture helper.
 *
 * In a checkout this is just `data/` and `bin/` — the same files, in the same
 * place, so nothing about development changes. In a release build it is inside
 * the bundle, which is code-signed: writing there would break the signature,
 * which is exactly why this is a separate idea from the one below.
 */
const ASSET_DIR = BUNDLED ? path.join(process.resourcesPath, 'data') : DATA_DIR;

/**
 * Everything the app writes: the user's config, and an index of their own if
 * they build one.
 *
 * A bundle in /Applications is not writable, and should not be. This is the
 * same directory bootstrap.js already keeps its pointer file in, so a release
 * install owns exactly one location under the user's home.
 */
const USER_DIR = BUNDLED
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Yomi Overlay')
  : DATA_DIR;

/** Build and side scripts, including the tier-2 sidecar. */
const TOOLS_DIR = path.join(PROJECT_ROOT, 'tools');

/** The Python venv the tier-2 sidecar runs in. ~2 GB, so it lives with the
 *  other generated bulk under data/ rather than beside the tracked scripts. */
const VENV_DIR = path.join(DATA_DIR, '.venv');

/** Compiled helpers. */
const BIN_DIR = BUNDLED
  ? path.join(process.resourcesPath, 'bin')
  : path.join(PROJECT_ROOT, 'bin');

/** The capture helper. Spawn failures here are reported by name in main.js. */
const OCR_BIN = path.join(BIN_DIR, 'yomi');

module.exports = {
  PROJECT_ROOT, APP_DIR, RENDERER_DIR, SETTINGS_DIR, PRELOAD_DIR,
  ASSETS_DIR, DATA_DIR, ASSET_DIR, USER_DIR, TOOLS_DIR, VENV_DIR,
  BIN_DIR, OCR_BIN, BUNDLED,
};
