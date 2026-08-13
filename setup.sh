#!/bin/bash
# One-time setup for Yomi Overlay. Idempotent — run it again after moving the
# project or upgrading Electron; it only redoes what is missing.
#
# What it guarantees: after this run, macOS permissions are granted ONCE and
# survive every future rebuild. That works because
#   1. a self-signed "Yomi Overlay Dev" certificate is created here (no
#      Keychain Access clicking), so the app's designated requirement is
#      certificate-based instead of a per-build cdhash, and
#   2. the bundle contains only shell/bootstrap.js — code, kindleocr and the
#      index all load from this directory, so editing them never touches the
#      bundle at all. Ordinary changes need an app restart, nothing more.
#
# TCC attributes both Screen Recording and Accessibility to the *responsible
# app* (Yomi Overlay), not to the kindleocr child it spawns — so rebuilding
# kindleocr costs nothing either.
#
# Expect up to two password/confirmation dialogs on the first run (trusting the
# new certificate, letting codesign use its key). That is the once.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# One file knows the layout; this script asks it. See overlay/paths.sh.
. "$HERE/overlay/paths.sh"
IDENTITY="${SIGN_IDENTITY:-Yomi Overlay Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
BUNDLE_ID="local.yomioverlay"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 1. Stable signing identity ---------------------------------------------
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  step "Signing identity \"$IDENTITY\" already exists — keeping it"
else
  step "Creating signing identity \"$IDENTITY\" (this is what makes permissions survive rebuilds)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  # Config file rather than -addext: macOS ships LibreSSL, which lacks -addext.
  cat > "$TMP/req.conf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/req.conf" 2>/dev/null
  openssl pkcs12 -export -out "$TMP/cert.p12" \
    -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass:yomi
  # -T pre-authorizes codesign to use the key, minimizing prompts.
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P yomi -T /usr/bin/codesign
  # Trust it for code signing (user domain). This is one of the dialogs.
  security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
  # Let codesign reach the key without a per-use prompt where possible.
  security set-key-partition-list -S apple-tool:,apple: -s -k "" "$KEYCHAIN" \
    2>/dev/null || true
  security find-identity -v -p codesigning | grep -F "$IDENTITY" \
    || { echo "certificate creation failed"; exit 1; }
fi

# --- 2. Node dependencies -----------------------------------------------------
if [ -d "$APP_DIR/node_modules/electron" ]; then
  step "npm dependencies present — skipping"
else
  step "Installing npm dependencies"
  ( cd "$APP_DIR" && npm install )
fi

# --- 3. Dictionaries ----------------------------------------------------------
if ls "$DATA_DIR"/dicts/*.zip >/dev/null 2>&1; then
  step "Dictionaries present — skipping download"
else
  step "Downloading freely licensed dictionaries"
  python3 "$TOOLS_DIR/fetch-dicts.py"
fi

# --- 4. Lookup index ----------------------------------------------------------
if [ -f "$DATA_DIR/index.db" ] && [ -f "$DATA_DIR/dictionaries.json" ]; then
  step "index.db present — skipping build (re-run overlay/build-index.py after adding dictionaries)"
else
  step "Building the lookup index (takes a few minutes)"
  python3 "$TOOLS_DIR/build-index.py"
fi

# --- 4.5 Tier-2 sidecar (manga-ocr) -------------------------------------------
# Optional: the overlay runs fine without it (tier2 disables itself with a log
# line). ~2GB of wheels + a ~450MB model download on first use.
if [ -x "$TOOLS_DIR/.venv/bin/python" ] && "$TOOLS_DIR/.venv/bin/python" -c 'import manga_ocr' 2>/dev/null; then
  step "manga-ocr sidecar present — skipping"
else
  step "Installing manga-ocr sidecar venv (Tier-2 second opinion; ~2GB)"
  python3 -m venv "$TOOLS_DIR/.venv"
  "$TOOLS_DIR/.venv/bin/pip" install --quiet manga-ocr || \
    step "manga-ocr install failed — tier2 will stay off (rerun setup.sh to retry)"
fi

# --- 5. Package, sign, install ------------------------------------------------
step "Building and installing Yomi Overlay.app (signed with \"$IDENTITY\")"
"$TOOLS_DIR/build-app.sh"

REQ="$(codesign -d -r- "/Applications/Yomi Overlay.app" 2>&1 | grep '^designated' || true)"
case "$REQ" in
  *cdhash*)
    echo "WARNING: the app is still ad-hoc signed; permissions will NOT survive rebuilds."
    echo "         Something went wrong creating the certificate above." ;;
esac

# --- 6. Clear stale permission grants ----------------------------------------
# If a previous ad-hoc build was ever granted anything, the grant is keyed to
# the dead identity and shows as a lying checkbox. Clear both so the lists
# start honest. Harmless when there is nothing to clear.
step "Resetting stale permission entries for $BUNDLE_ID"
tccutil reset ScreenCapture  "$BUNDLE_ID" 2>/dev/null || true
tccutil reset Accessibility  "$BUNDLE_ID" 2>/dev/null || true

# --- 7. Permissions -----------------------------------------------------------
step "Grant the two permissions (the only manual step, and the last time)"
cat <<'EOF'
    System Settings → Privacy & Security →
      • Screen Recording  → +  → /Applications/Yomi Overlay.app
          (required for every capture — nothing works without it)
      • Accessibility     → +  → /Applications/Yomi Overlay.app
          (powers the Shift-press/click trigger; without it Shift only
           works while the mouse is moving)

    Both panes are being opened for you now.
EOF
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
sleep 1
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

step "Done"
echo "    Launch:   open -a 'Yomi Overlay'   (or Spotlight; look for the 読 menu-bar item)"
echo "    Settings: ⌘⌥S — pick the target window (shift-click pins one window)"
echo
echo "    From now on:"
echo "      edit overlay JS / rebuild kindleocr  → just restart the app"
echo "      re-run build-app.sh (Electron bump)  → same identity, permissions kept"
echo "      moving the project                   → re-run this script (or edit the"
echo "                                             pointer file build-app.sh writes)"
