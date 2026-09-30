#!/bin/bash
# Convenience wrapper: build the sandboxed MAS bundle into /Applications.
#
# Usage:
#   tools/mas/install.sh              # build + sign + install
#   tools/mas/install.sh --open       # … then launch it
#
# Everything below can be overridden with env vars if you ever need to,
# but the defaults are this project's actual values.
set -euo pipefail

export SIGN_IDENTITY="${SIGN_IDENTITY:-3rd Party Mac Developer Application: Vectorsoft (3EPV7AGLM2)}"
export TEAM_ID="${TEAM_ID:-3EPV7AGLM2}"
export BUNDLE_ID="${BUNDLE_ID:-com.dcambur.yomioverlay}"
export PROVISION="${PROVISION:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/credentials/Yomi_Overlay_MAS.provisionprofile}"

# Build in a scratch dir, then copy only the finished bundle into place.
STAGE="${OUT_DIR:-/tmp/mas}"
export OUT_DIR="$STAGE"
DEST="/Applications/Yomi Overlay.app"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build-mas.sh"

echo "==> Installing to $DEST"
rm -rf "$DEST"
ditto "$STAGE/Yomi Overlay-mas-arm64/Yomi Overlay.app" "$DEST"

if [[ "${1:-}" == "--open" ]]; then
  open "$DEST"
fi
