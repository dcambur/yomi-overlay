#!/bin/bash
# Every test, from one command. No window opens on the user's screen; the one
# visible sign is the app's menu-bar icon while the real app is under test.
#
#   test/run.sh                 every lane
#   test/run.sh logic pages     just those lanes
#   test/run.sh golden record|check NAME
#   VERBOSE=1 test/run.sh ...   with the pages' and the app's own output
#
# The lanes, by what they need:
#
#   logic   node                 node:test suites — lookup, the index builder,
#                                dictionaries, config, Anki, child supervision
#   pages   Electron             the overlay page and the settings page, in one
#                                hidden accessory Electron (test/pages/pages.js)
#   screen  Electron, swiftc,    the real window server, capture helper and
#           Screen Recording     app, on an invisible display: selection,
#                                covers, idle, glyph placement, tategaki,
#                                fullscreen, the picker, and the app end to end
#                                (test/screen/screen.js)
#   golden  a built bin/yomi     byte-exact regression net over yomi --image;
#                                not part of `all` — it compares two builds
#
# A lane that cannot run on this machine says why and fails: "all green" must
# never mean "the interesting part did not run".
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../tools/paths.sh"
ELECTRON="$APP_DIR/node_modules/.bin/electron"
HELPERS="$BIN_DIR/test"

if [ "${1:-}" = golden ]; then
  shift
  exec "$HERE/golden.sh" "$@"
fi

LANES="${*:-logic pages screen}"
rc=0

# Everything a run writes to a temp dir goes under one, removed however the
# run ends: suites left eight directories behind per logic run (215 had piled
# up), and a screen suite stopped at its limit skips its own cleanup. Short, in
# /tmp: Chromium puts the app's single-instance socket under TMPDIR, and a
# socket path is capped at 104 bytes.
SCRATCH="$(mktemp -d /tmp/yomi-test.XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT
export TMPDIR="$SCRATCH/"
lane() { case " $LANES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
cannot() { echo "  ✗ $1" >&2; rc=1; }
elapsed() { echo "  ($(( $(date +%s) - $1 ))s)"; }

# A test helper, compiled into bin/test/ when missing or older than a source.
# Every .h among the sources is the bridging header for the Swift ones.
helper() {
  local out="$HELPERS/$1" src stale=0 header=() swift=()
  shift
  [ -x "$out" ] || stale=1
  for src in "$@"; do
    [ "$src" -nt "$out" ] && stale=1
    case "$src" in *.h) header=(-import-objc-header "$src") ;; *) swift+=("$src") ;; esac
  done
  [ "$stale" = 1 ] || return 0
  mkdir -p "$HELPERS"
  echo "  building $out"
  swiftc -O ${header[@]+"${header[@]}"} "${swift[@]}" -o "$out"
}

electron() {
  # ELECTRON_RUN_AS_NODE is set in some parent environments; it would start
  # Electron as a bare node and never create a window.
  env -u ELECTRON_RUN_AS_NODE "$ELECTRON" "$@"
}

for l in $LANES; do
  case "$l" in logic|pages|screen|firstrun|idle|spaces) ;; *)
    echo "usage: test/run.sh [logic] [pages] [screen] [firstrun] [idle] [spaces]" \
         "| golden record|check NAME" >&2
    exit 2 ;;
  esac
done

if lane logic; then
  echo "== logic =="
  t=$(date +%s)
  # An explicit file list: `node --test <dir>` would also run pages.js and the
  # screen suite, which need Electron. --test-timeout bounds each test, not a
  # file: a suite that leaves a handle open ends with --test-force-exit rather
  # than holding the lane open once its tests are done.
  node --test --test-timeout=30000 --test-force-exit "$HERE"/logic/*.test.js || rc=1
  elapsed "$t"
fi

if lane pages; then
  echo "== pages =="
  t=$(date +%s)
  if [ -x "$ELECTRON" ]; then
    electron "$HERE/pages/pages.js" || rc=1
  else
    cannot "electron is not installed — run setup.sh (or npm install in app/)"
  fi
  elapsed "$t"
fi

# What every lane on the invisible display needs, checked once: it says why
# and fails rather than skipping.
stage_ready() {
  if [ -n "${STAGE_OK:-}" ]; then return "$STAGE_OK"; fi
  STAGE_OK=1
  if [ ! -x "$ELECTRON" ]; then
    cannot "electron is not installed — run setup.sh (or npm install in app/)"
  elif [ ! -x "$OCR_BIN" ]; then
    cannot "no capture helper at $OCR_BIN — run ocr/build.sh"
  elif ! command -v swiftc > /dev/null; then
    cannot "swiftc not found — install the Xcode command line tools"
  elif ! "$OCR_BIN" --check-permission | grep -q '"screenRecording":true'; then
    cannot "this terminal has no Screen Recording grant (System Settings → Privacy
    & Security → Screen Recording), so nothing can be captured"
  elif pgrep -f '/yomi --json --watch' > /dev/null; then
    cannot "the overlay is running — quit it first: a second capture session
    stalls behind its watch loop (CONVENTIONS.md, gotchas)"
  elif ! helper virtual-display "$HERE/stage/VirtualDisplay.h" \
         "$HERE/stage/virtual-display.swift" \
       || ! helper RigWithANameTheWindowServerTruncates.exe "$HERE/screen/picker-rig.swift"; then
    cannot "a test helper did not compile"
  else
    STAGE_OK=0
  fi
  return "$STAGE_OK"
}

# A lane on the invisible display: `stage_lane NAME ENTRY`.
stage_lane() {
  echo "== $1 =="
  local t
  t=$(date +%s)
  if stage_ready; then
    # A helper never run before spends its first read compiling Vision's model
    # (29-64 s); the screen lane pays that once, up front, and says so.
    local warm="$HELPERS/.yomi-warm"
    if [ "$1" = screen ] && { [ "$OCR_BIN" -nt "$warm" ] || [ ! -f "$warm" ]; }; then
      YOMI_WARM=1 electron "$2" && touch "$warm" || rc=1
    else
      electron "$2" || rc=1
    fi
  fi
  elapsed "$t"
}

if lane screen; then stage_lane screen "$HERE/screen/screen.js"; fi
if lane firstrun; then stage_lane firstrun "$HERE/firstrun/firstrun.js"; fi
if lane idle; then stage_lane idle "$HERE/idle/idle.js"; fi
if lane spaces; then stage_lane spaces "$HERE/spaces/spaces.js"; fi

[ $rc -eq 0 ] && echo "all lanes passed"
exit $rc
