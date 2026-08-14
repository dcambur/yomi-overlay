#!/bin/bash
# Build a .app that runs on a machine with no checkout: the release build.
#
# The difference from build-app.sh is one directory. That script packages
# app/shell/ and leaves the bundle a loader pointed at your working copy — the
# arrangement ARCHITECTURE §6 exists to protect, because it keeps the bundle's
# hash (and therefore its TCC grants) stable while you edit code. This one adds
# a copy of the app, the capture helper and a dictionary index INSIDE the
# bundle, which bootstrap.js looks for last. A developer's pointer file still
# wins, so installing a release build does not disturb a development one.
#
# Dictionaries: whatever is in data/dicts/ at build time goes into the index,
# so this script REFUSES to run unless every dictionary present is one
# fetch-dicts.py is willing to download — that script's list is the project's
# record of what is freely licensed. Publishing 三省堂 or 明鏡 in a GitHub
# release is republishing a commercial dictionary; the check is here so that
# cannot happen by forgetting.
#
#   tools/build-release.sh              # -> /tmp/release/Yomi Overlay.app
#   SIGN_IDENTITY="Developer ID Application: ..." tools/build-release.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/paths.sh"

APP_NAME="Yomi Overlay"
OUT="${OUT_DIR:-/tmp/release}"
BUILT="$OUT/$APP_NAME-darwin-arm64/$APP_NAME.app"
RES="$BUILT/Contents/Resources"
ELECTRON_VERSION="$(node -p "require('$APP_DIR/package.json').devDependencies.electron.replace(/^[^0-9]*/, '')")"

echo "==> Checking every bundled dictionary is redistributable"
python3 - "$DATA_DIR" "$TOOLS_DIR/fetch-dicts.py" "$TOOLS_DIR/build-index.py" <<'PY'
import sys, pathlib, re, json

data = pathlib.Path(sys.argv[1])

# The names fetch-dicts.py knows how to download ARE the freely-licensed set;
# its docstring is this project's statement about which those are. Reading them
# out of the source keeps one list instead of two that drift apart.
allowed = set(re.findall(r'"([A-Za-z0-9_.\-]+\.zip)"',
                         pathlib.Path(sys.argv[2]).read_text()))
# ...and build-index.py's DICT_LABELS turns those into the names that end up in
# the manifest, so the display-name check needs no list of its own either.
labels = dict(re.findall(r'"([A-Za-z0-9_.\-]+\.zip)":\s*"([^"]+)"',
                         pathlib.Path(sys.argv[3]).read_text()))
if not allowed or not labels:
    sys.exit('  could not read the allowed set out of the tools')

fail = []

# 1. The inputs sitting in dicts/.
present = {p.name for p in (data / 'dicts').glob('*.zip')}
fail += [f'    {n}  (dictionary)' for n in sorted(present - allowed)]

# 2. The INDEX, which is what actually ships. dicts/ only says how it was
#    built, and a stale index outlives the zips it came from — checking the
#    manifest is what makes this a statement about the artifact.
manifest = data / 'dictionaries.json'
if manifest.exists():
    ok_labels = {labels[z] for z in allowed if z in labels}
    for name in json.loads(manifest.read_text()):
        if name not in ok_labels:
            fail.append(f'    {name}  (indexed in index.db)')

if fail:
    print('  REFUSING to build a release containing:', file=sys.stderr)
    print('\n'.join(fail), file=sys.stderr)
    print('\n  These are not in fetch-dicts.py, which is this project\'s record'
          '\n  of what is freely licensed. Publishing them would republish a'
          '\n  commercial dictionary. Build the release in a clean checkout,'
          '\n  where fetch-dicts.py + build-index.py produce a free index by'
          '\n  construction.', file=sys.stderr)
    sys.exit(1)
print(f'  ok — {len(present)} dictionaries, and the index declares nothing else')
PY

echo "==> Building the Swift capture helper"
"$HERE/../ocr/build.sh" >/dev/null

echo "==> Packaging the loader shell (Electron $ELECTRON_VERSION)"
rm -rf "$OUT"
# The release tag, minus its v, so Finder's Get Info and the About panel say
# which build this is. Permissions have to be re-granted after an unsigned
# update, so "which build am I running" is a question users will actually ask.
APP_VERSION="${APP_VERSION:-0.0.0-dev}"
npx --yes @electron/packager "$SHELL_DIR" "$APP_NAME" \
  --platform=darwin --arch=arm64 \
  --electron-version="$ELECTRON_VERSION" \
  --app-bundle-id=local.yomioverlay \
  --app-version="$APP_VERSION" \
  --extend-info="$TOOLS_DIR/extend.plist" \
  --out="$OUT" --overwrite >/dev/null

cp "$TOOLS_DIR/icon.icns" "$RES/electron.icns"

echo "==> Copying the app into the bundle"
# Everything paths.js resolves off APP_DIR, and nothing else. node_modules is
# devDependencies only (electron itself) — the app requires nothing at runtime.
mkdir -p "$RES/app"
for part in main.js paths.js main renderer settings preload assets vendor package.json; do
  [ -e "$APP_DIR/$part" ] && cp -R "$APP_DIR/$part" "$RES/app/"
done
rm -rf "$RES/app/shell"

echo "==> Copying the helper and the index"
mkdir -p "$RES/bin" "$RES/data"
cp "$OCR_BIN" "$RES/bin/yomi"
cp "$DATA_DIR/index.db" "$RES/data/index.db"
cp "$DATA_DIR/dictionaries.json" "$RES/data/dictionaries.json"

IDENTITY="${SIGN_IDENTITY:-}"
if [ -n "$IDENTITY" ] && security find-identity -v -p codesigning 2>/dev/null \
     | grep -qF "$IDENTITY"; then
  echo "==> Signing with \"$IDENTITY\""
  codesign --force --deep --options runtime --sign "$IDENTITY" "$BUILT"
else
  # Ad-hoc: the identity is a bare cdhash, so it changes with every build and
  # macOS treats each release as a new app that has been granted nothing. Say
  # so rather than letting it be discovered after an update.
  echo "==> No SIGN_IDENTITY — signing ad-hoc."
  echo "    Downloads will be quarantined, and Screen Recording / Accessibility"
  echo "    must be granted again after every update."
  codesign --force --deep --sign - "$BUILT"
fi

SIZE="$(du -sh "$BUILT" | cut -f1)"
echo
echo "==> Done: $BUILT ($SIZE)"
codesign -d -r- "$BUILT" 2>&1 | sed -n 's/^# designated/    designated/p'
