// Data lives outside the app bundle: the dictionary index alone is ~370 MB and
// the dictionaries another ~100 MB, none of which should be duplicated into a
// packaged .app on every rebuild. The bundle lives in /Applications while the
// data stays with the project, so these must be absolute — but they are
// *derived*, not written down. A literal path only ever describes one machine,
// and a clone on any other one failed at spawn() with ENOENT.
//
// __dirname is this file's own directory, which IS the data directory: the
// bundle contains only shell/bootstrap.js, so whatever loaded main.js loaded it
// from the project (see shell/bootstrap.js). YOMI_OVERLAY_DIR is what bootstrap
// resolved and re-exported; honouring it first keeps a deliberate override
// (a second checkout, a test rig) working.
const path = require('path');

const DATA_DIR = process.env.YOMI_OVERLAY_DIR || __dirname;
const OCR_BIN = path.join(DATA_DIR, '..', 'kindleocr');

module.exports = { DATA_DIR, OCR_BIN };
