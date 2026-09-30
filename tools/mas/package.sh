#!/bin/bash
# Build the signed installer package App Store Connect accepts.
#
# Usage:
#   tools/mas/package.sh 1.0.0
#
# Output: /tmp/mas/Yomi Overlay-<version>.pkg — upload it with the
# Transporter app (App Store submissions take a signed .pkg, not the .app).
set -euo pipefail

VERSION="${1:?usage: package.sh <version, e.g. 1.0.0>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export APP_VERSION="$VERSION"
export SIGN_IDENTITY="${SIGN_IDENTITY:-3rd Party Mac Developer Application: Vectorsoft (3EPV7AGLM2)}"
export TEAM_ID="${TEAM_ID:-3EPV7AGLM2}"
export BUNDLE_ID="${BUNDLE_ID:-com.dcambur.yomioverlay}"
export PROVISION="${PROVISION:-$HERE/credentials/Yomi_Overlay_MAS.provisionprofile}"
export OUT_DIR="${OUT_DIR:-/tmp/mas}"

"$HERE/build-mas.sh"

INSTALLER="${INSTALLER_IDENTITY:-3rd Party Mac Developer Installer: Vectorsoft ($TEAM_ID)}"
PKG="$OUT_DIR/Yomi Overlay-$VERSION.pkg"
echo "==> Signing installer package with \"$INSTALLER\""
productbuild \
  --component "$OUT_DIR/Yomi Overlay-mas-arm64/Yomi Overlay.app" /Applications \
  --sign "$INSTALLER" \
  "$PKG"

echo
echo "==> Ready to upload: $PKG"
