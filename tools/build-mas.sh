#!/bin/bash
# Build a SANDBOXED Mac App Store bundle.
#
# Separate from build-release.sh on purpose. That script is what
# .github/workflows/release.yml runs and notarizes, and it produces the
# Developer ID zip people actually download; a `mas` build cannot run from a
# zip, so folding the two together would break public releases the first time
# it ran.
#
# WHAT THIS IS MOSTLY FOR, TODAY: answering one question before anyone spends a
# week on App Store work — does this app still function under the App Sandbox?
# Capture and the global modifier monitor are the whole product, and both are
# TCC grants rather than entitlements, so no amount of reading settles it. A
# self-signed sandboxed build settles it in ten minutes:
#
#   tools/build-mas.sh                       # self-signed, sandboxed, LOCAL ONLY
#   open "/tmp/mas/Yomi Overlay-mas-arm64/Yomi Overlay.app"
#   # grant Screen Recording + Accessibility to the NEW bundle, then read
#   tail -f /tmp/yomi-overlay.log
#
# Quit the development overlay first: two ScreenCaptureKit sessions fight, and
# the one-shot capture hangs (docs/CONVENTIONS.md, "Gotchas").
#
# The sandbox is enforced by the entitlement, not by who signed it, so a
# self-signed build tests the real thing. What self-signing CANNOT test is
# submission: that needs a "3rd Party Mac Developer Application" identity and an
# embedded provisioning profile, neither of which exists yet.
#
#   SIGN_IDENTITY="3rd Party Mac Developer Application: NAME (TEAMID)" \
#     PROVISION=/path/to/profile.provisionprofile tools/build-mas.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/paths.sh"

APP_NAME="Yomi Overlay"
OUT="${OUT_DIR:-/tmp/mas}"
BUILT="$OUT/$APP_NAME-mas-arm64/$APP_NAME.app"
RES="$BUILT/Contents/Resources"
ELECTRON_VERSION="$(node -p "require('$APP_DIR/package.json').devDependencies.electron.replace(/^[^0-9]*/, '')")"
APP_VERSION="${APP_VERSION:-0.0.0-dev}"
# Self-signed by default so the sandbox question can be answered without an
# Apple Developer account. build-app.sh creates this certificate.
IDENTITY="${SIGN_IDENTITY:-Yomi Overlay Dev}"
ENTITLEMENTS="$TOOLS_DIR/entitlements.mas.plist"
INHERIT="$TOOLS_DIR/entitlements.mas.inherit.plist"

echo "==> Building the Swift capture helper"
"$HERE/../ocr/build.sh" >/dev/null

echo "==> Packaging (Electron $ELECTRON_VERSION, platform=mas)"
rm -rf "$OUT"
# platform=mas, not darwin. The darwin build links private APIs and is rejected
# on sight; the mas build is the same Electron with those excluded. For this app
# the exclusions cost nothing measurable — crashReporter and autoUpdater are the
# disabled modules and neither is used, and the "video capture may not work"
# caveat is about Electron's own capture stack, while every pixel here comes
# from ScreenCaptureKit inside yomi.
npx --yes @electron/packager "$SHELL_DIR" "$APP_NAME" \
  --platform=mas --arch=arm64 \
  --electron-version="$ELECTRON_VERSION" \
  --app-bundle-id="${BUNDLE_ID:-local.yomioverlay}" \
  --app-version="$APP_VERSION" \
  --extend-info="$TOOLS_DIR/extend.plist" \
  --out="$OUT" --overwrite >/dev/null

cp "$TOOLS_DIR/icon.icns" "$RES/electron.icns"

echo "==> Copying the app into the bundle"
mkdir -p "$RES/app"
for part in main.js paths.js main renderer settings preload assets vendor package.json; do
  [ -e "$APP_DIR/$part" ] && cp -R "$APP_DIR/$part" "$RES/app/"
done
rm -rf "$RES/app/shell"

echo "==> Copying the helper into Contents/MacOS"
# Beside the app's own executable, matching paths.js. Nested code in Resources
# is exactly what App Store validation rejects.
cp "$OCR_BIN" "$BUILT/Contents/MacOS/yomi"

echo "==> Removing unused Chromium locales"
FW_RES="$BUILT/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
if [ -d "$FW_RES" ]; then
  find "$FW_RES" -maxdepth 1 -name '*.lproj' ! -name 'en.lproj' -exec rm -rf {} +
fi

# --- the two things a hand-rolled signature has to add itself ----------------
# Electron's MAS guide is explicit: an app signed WITHOUT @electron/osx-sign
# must carry `com.apple.security.application-groups` in its entitlements and
# `ElectronTeamID` in its Info.plist. osx-sign derives both from the certificate
# name; signing by hand means deriving them here. Both are Team ID values, so
# both are impossible without an Apple Developer account — and the app-groups
# container is how Chromium's helpers reach the main process under the sandbox,
# so a build missing it can fail to launch for reasons that have nothing to do
# with capture. That distinction matters when reading the result of this build.
ENTS="$OUT/entitlements.generated.plist"
cp "$ENTITLEMENTS" "$ENTS"
if [ -n "${TEAM_ID:-}" ]; then
  echo "==> Injecting Team ID $TEAM_ID"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.application-groups array" \
    -c "Add :com.apple.security.application-groups:0 string $TEAM_ID.${BUNDLE_ID:-local.yomioverlay}" \
    "$ENTS" >/dev/null
  /usr/libexec/PlistBuddy -c "Add :ElectronTeamID string $TEAM_ID" \
    "$BUILT/Contents/Info.plist" >/dev/null
else
  echo "==> WARNING: no TEAM_ID set."
  echo "    No application-groups entitlement and no ElectronTeamID. This build"
  echo "    is NOT submittable, and if it fails to launch, suspect this before"
  echo "    you suspect the sandbox: Chromium's helpers reach the main process"
  echo "    through the group container, and it is absent."
fi

if [ -n "${PROVISION:-}" ]; then
  echo "==> Embedding the provisioning profile"
  cp "$PROVISION" "$BUILT/Contents/embedded.provisionprofile"
else
  echo "==> No PROVISION set — local sandbox test build, not submittable."
fi

echo "==> Signing inside-out with \"$IDENTITY\""
# Innermost first, and every nested executable gets the INHERIT entitlements
# rather than the app's own — a child that could name its own permissions could
# widen the sandbox, so Apple rejects that outright.
#
# Done by hand rather than with @electron/osx-sign because that package's CLI
# takes seven flags and --identity is not among them (2.7.0 parses argv with
# node:util parseArgs, strict, so an unknown flag throws); its per-file
# entitlements live in a JS API instead. Fifteen lines here beats a dependency
# and a wrapper script. `codesign --deep`, which build-app.sh and
# build-release.sh still use, is the shortcut this replaces: it applies ONE set
# of entitlements to everything it finds, which for a sandbox is the wrong
# answer at every nested path.
#
# No --options runtime: the hardened runtime is a Developer ID / notarization
# requirement, and combining it with the App Sandbox is not what Apple's own
# MAS instructions do.
TS=(--timestamp=none)                      # self-signed: nothing to timestamp against
[ -n "${SIGN_IDENTITY:-}" ] && TS=(--timestamp)

sign() { codesign --force --sign "$IDENTITY" "${TS[@]}" --entitlements "$2" "$1"; }

# 1. Libraries inside the framework, then the framework itself.
while IFS= read -r lib; do sign "$lib" "$INHERIT"; done < <(
  find "$BUILT/Contents/Frameworks/Electron Framework.framework" -name '*.dylib')
sign "$BUILT/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" "$INHERIT"
sign "$BUILT/Contents/Frameworks/Electron Framework.framework" "$INHERIT"

# 2. Every nested .app: the four Electron helpers and the login helper.
while IFS= read -r nested; do sign "$nested" "$INHERIT"; done < <(
  find "$BUILT/Contents/Frameworks" "$BUILT/Contents/Library" -name '*.app' -maxdepth 2)

# 3. The capture helper, which is the one nested binary that is ours.
sign "$BUILT/Contents/MacOS/yomi" "$INHERIT"

# 4. The app last, and this is the only signature that carries the real sandbox.
sign "$BUILT" "$ENTS"

echo
echo "==> Done: $BUILT"
echo "    sandboxed:  $(codesign -d --entitlements - "$BUILT" 2>/dev/null \
                        | grep -c app-sandbox) app-sandbox entitlement(s)"
codesign -dv "$BUILT" 2>&1 | sed -n 's/^Identifier=/    identifier: /p'
echo
echo "    Quit the development overlay, then launch this one and re-grant"
echo "    Screen Recording + Accessibility to it. Whether capture and the"
echo "    Shift monitor still work IS the experiment."
