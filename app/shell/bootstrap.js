// The entire contents of the .app bundle. Deliberately tiny and deliberately
// stable.
//
// Why this exists: the bundle is signed ad-hoc, so its designated requirement
// is a bare cdhash of the binary —
//
//     designated => cdhash H"749fab8e41c3c56c6de224e4e721d52b1f12146a"
//
// TCC keys Screen Recording and Accessibility on that requirement, so every
// repackage produces a different identity and macOS correctly treats it as a
// brand-new app that has never been granted anything. Signing with a stable
// certificate fixes the identity; keeping the bundle byte-identical across code
// changes means we rarely have to repackage at all.
//
// So a development bundle holds only this file, and the real main process is
// loaded from the project directory — the same place index.db, dicts/ and yomi
// are already read from (see paths.js). Editing main.js, index.html or
// lookup.js then needs nothing but a restart of the app.
//
// Repackage only when this file, extend.plist, or the Electron version changes.
//
// A RELEASE bundle additionally carries a copy of the app, the helper and a
// freely-licensed index in Contents/Resources, so it runs on a machine with no
// checkout (tools/build-release.sh). That copy is the LAST place looked, so a
// developer's pointer file still wins and nothing above changes for them.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FALLBACK = '/Users/dcambur/Desktop/kindle_stuff/reader/app';
// A pointer file means moving the project needs no rebuild either — just edit
// this one line of text.
const POINTER = path.join(
  os.homedir(), 'Library', 'Application Support', 'Yomi Overlay', 'project-path');

function resolveProjectDir() {
  const candidates = [];
  if (process.env.YOMI_OVERLAY_DIR) candidates.push(process.env.YOMI_OVERLAY_DIR);
  try {
    const p = fs.readFileSync(POINTER, 'utf8').trim();
    if (p) candidates.push(p);
  } catch { /* no pointer file — normal */ }
  candidates.push(FALLBACK);
  // A release build carries its own copy. LAST on purpose: a developer's
  // pointer file must still win, so the same bundle keeps loading a checkout
  // and "restart, don't rebuild" survives. Only an install that has no
  // checkout to find falls through to here.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app'));
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'main.js'))) return dir;
  }
  return null;
}

const dir = resolveProjectDir();

if (!dir) {
  // Nothing to load. Say exactly what is missing and where it was looked for,
  // rather than dying with a stack trace no one will ever see — the app is
  // LSUIElement, launched from Spotlight, with no terminal attached.
  const { app, dialog } = require('electron');
  const detail =
    'Looked for main.js in:\n' +
    `  $YOMI_OVERLAY_DIR  (${process.env.YOMI_OVERLAY_DIR || 'unset'})\n` +
    `  ${POINTER}\n` +
    `  ${FALLBACK}\n` +
    `  ${process.resourcesPath ? path.join(process.resourcesPath, 'app') : '(no bundle)'}\n\n` +
    'The app bundle intentionally contains only a loader; the code lives with ' +
    'index.db and dicts/. Point it at the project by writing the path into the ' +
    'file above, or set YOMI_OVERLAY_DIR.';
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Yomi Overlay: project directory not found',
      message: 'Cannot find the overlay source directory.',
      detail,
      buttons: ['Quit'],
    });
    app.quit();
  });
} else {
  process.env.YOMI_OVERLAY_DIR = dir;   // so the loaded code can find its own home
  require(path.join(dir, 'main.js'));
}
