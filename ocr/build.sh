#!/bin/bash
# Build the capture helper.
#
# Multiple files, one swiftc invocation, no Package.swift. Verified: globals
# declared in one file are visible from another, and @main works in any file
# under -parse-as-library — so the split costs nothing at the build line and
# the "single command, no manifest" property in CONVENTIONS.md survives.
#
# -O with several files is whole-module by default, so splitting does not cost
# cross-file inlining either. What it DOES cost: `private` at file scope no
# longer reaches across the split, which is why the shared ink helpers are
# internal.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../tools/paths.sh"

mkdir -p "$BIN_DIR"
swiftc -O -parse-as-library "$OCR_SRC"/*.swift -o "$OCR_BIN"
echo "built $OCR_BIN"
