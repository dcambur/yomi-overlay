#!/bin/bash
# Build the lookup index from the dictionaries in data/dicts/ (or
# $YOMI_USER_DIR/dicts), with the app's own builder — the one Settings uses.
#
# It stores each glossary as its dictionary wrote it and keeps per-dictionary
# rows, so an unknown dictionary still renders and removing one is a prune, not
# a rebuild (ARCHITECTURE sections 8 and 13). tools/build-index.py is the old,
# flattening builder, kept only so a test can make the legacy schema.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/paths.sh"
ELECTRON="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "electron is not installed — run setup.sh" >&2; exit 2; }

# The app's own runtime, as a plain node: node:sqlite is what it indexes with.
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e "
  const { rebuild } = require(process.argv[1]);
  const { labels } = rebuild((p) => {
    if (p.phase === 'indexing' && p.name) process.stdout.write('\r  indexing ' + p.name + '   ');
  });
  console.log('\nindexed: ' + labels.join(', '));
" "$APP_DIR/main/dictionaries.js"
