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
export OUT_DIR="${OUT_DIR:-/Applications}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/build-mas.sh"

if [[ "${1:-}" == "--open" ]]; then
  open "/Applications/Yomi Overlay-mas-arm64/Yomi Overlay.app"
fi
