#!/bin/bash
# Rebuild and install Yomi Overlay.app.
#
# You should rarely need this. The bundle contains only shell/bootstrap.js,
# which loads main.js from this directory at runtime — so ordinary code changes
# take effect on the next app restart with no rebuild at all. Run this only when
# bootstrap.js, extend.plist, the icon, or the Electron version changes.
#
# Signing: macOS keys Screen Recording and Accessibility to the app's designated
# requirement. Ad-hoc signing makes that a bare cdhash, so every rebuild is a new
# app and every permission is lost. With a self-signed certificate in the login
# keychain the requirement becomes certificate-based and survives rebuilds, so
# this script prefers one and warns loudly when it has to fall back.
#
#   Keychain Access → Certificate Assistant → Create a Certificate…
#     Name: Yomi Overlay Dev   Identity Type: Self Signed Root
#     Certificate Type: Code Signing
#
# Override the identity with:  SIGN_IDENTITY="Some Other Name" ./build-app.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# One file knows the layout; this script asks it. See paths.sh.
. "$HERE/paths.sh"
ELECTRON_VERSION="$(node -p "require('$APP_DIR/package.json').devDependencies.electron.replace(/^[^0-9]*/, '')")"
APP_NAME="Yomi Overlay"
OUT="/tmp/pack"
DEST="/Applications/$APP_NAME.app"
BUILT="$OUT/$APP_NAME-darwin-arm64/$APP_NAME.app"
IDENTITY="${SIGN_IDENTITY:-Yomi Overlay Dev}"

echo "==> Building the Swift capture helper"
swiftc -O -parse-as-library "$OCR_SRC" -o "$OCR_BIN"

echo "==> Packaging the loader shell (Electron $ELECTRON_VERSION)"
rm -rf "$OUT"
npx --yes @electron/packager "$SHELL_DIR" "$APP_NAME" \
  --platform=darwin --arch=arm64 \
  --electron-version="$ELECTRON_VERSION" \
  --app-bundle-id=local.yomioverlay \
  --extend-info="$APP_DIR/extend.plist" \
  --out="$OUT" --overwrite >/dev/null

cp "$APP_DIR/icon.icns" "$BUILT/Contents/Resources/electron.icns"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "==> Signing with \"$IDENTITY\" (stable identity — permissions survive)"
  codesign --force --deep --sign "$IDENTITY" "$BUILT"
else
  echo "==> WARNING: no code-signing identity named \"$IDENTITY\" found."
  echo "    Falling back to ad-hoc. macOS will treat this as a NEW app and you"
  echo "    will have to re-grant Screen Recording and Accessibility."
  echo "    Create one: Keychain Access → Certificate Assistant →"
  echo "    Create a Certificate… → \"$IDENTITY\", Self Signed Root, Code Signing"
  codesign --force --deep --sign - "$BUILT"
fi

echo "==> Installing to $DEST"
osascript -e "quit app \"$APP_NAME\"" 2>/dev/null || true
pkill -f "$DEST/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "$DEST"
cp -R "$BUILT" /Applications/

# Record where the code lives, so a moved project needs no rebuild. This must
# be the directory holding the entry main.js — bootstrap.js probes for exactly
# that file, and paths.js derives every other root from it.
SUPPORT="$HOME/Library/Application Support/$APP_NAME"
mkdir -p "$SUPPORT"
printf '%s\n' "$APP_DIR" > "$SUPPORT/project-path"

echo
echo "==> Done."
codesign -d -r- "$DEST" 2>&1 | sed -n 's/^# designated/    designated/p'
echo "    code loaded from: $APP_DIR"
