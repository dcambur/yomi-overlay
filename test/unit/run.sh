#!/bin/bash
# Every test that needs no permission, no window, and no network.
#
# Two runners, because the two suites need different hosts:
#
#   *.test.js     plain node (node:test). Pure logic against real data.
#   renderer.js   electron, hidden window. Needs Chromium layout —
#                 getBoundingClientRect and elementsFromPoint are what the
#                 glyph layer and pickGlyph are built on, and no DOM shim
#                 reproduces them honestly.
#
# Neither shows anything on screen, and neither captures anything, so this is
# safe to run while the overlay is up and safe to run unattended.
#
#   test/unit/run.sh            everything
#   test/unit/run.sh node       just the node suites
#   test/unit/run.sh renderer   just the renderer suite
#   VERBOSE=1 test/unit/run.sh renderer     with renderer console output
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../tools/paths.sh"
ELECTRON="$APP_DIR/node_modules/.bin/electron"
WHICH="${1:-all}"
rc=0

if [ "$WHICH" = all ] || [ "$WHICH" = node ]; then
  echo "== node suites =="
  # Explicit file list: `node --test <dir>` treats every .js under a directory
  # named test/ as a test file, which would try to run renderer.js without
  # Electron and fail on `require('electron')`.
  node --test "$HERE"/*.test.js || rc=1
fi

if [ "$WHICH" = all ] || [ "$WHICH" = renderer ]; then
  echo "== renderer suite (hidden Electron window) =="
  if [ ! -x "$ELECTRON" ]; then
    echo "  electron not installed — run setup.sh (or npm install in app/)" >&2
    rc=1
  else
    # ELECTRON_RUN_AS_NODE is set in some parent environments; it would start
    # electron as a bare node and never create a window.
    env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "$HERE/renderer.js" || rc=1
  fi
fi

exit $rc
