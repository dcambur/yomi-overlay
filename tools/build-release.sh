#!/bin/bash
# Build a .app that runs on a machine with no checkout: the release build.
#
# The difference from build-app.sh is one directory. That script packages
# app/shell/ and leaves the bundle a loader pointed at your working copy — the
# arrangement ARCHITECTURE §6 exists to protect, because it keeps the bundle's
# hash (and therefore its TCC grants) stable while you edit code. This one adds
# a copy of the app and the capture helper INSIDE the bundle, which
# bootstrap.js looks for last. A developer's pointer file still wins, so
# installing a release build does not disturb a development one.
#
# NO DICTIONARY SHIPS. The app downloads or imports one from its settings
# window on first run, which is a stronger position than checking what is
# about to be published: there is nothing licensed in the bundle to get wrong.
# It also takes the download from ~465 MB to ~275 MB, of which Electron is
# nearly all of what remains.
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

echo "==> Copying the helper"
mkdir -p "$RES/bin"
cp "$OCR_BIN" "$RES/bin/yomi"

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
