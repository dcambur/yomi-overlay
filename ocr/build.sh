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
# Recursive: sources are grouped into subdirectories by pipeline stage.
# Read loop rather than mapfile — macOS ships bash 3.2, which has no mapfile.
# Sorted so the compiler sees a stable order and the build is reproducible.
SWIFT=()
while IFS= read -r f; do SWIFT+=("$f"); done < <(find "$OCR_SRC" -name '*.swift' | sort)
[ "${#SWIFT[@]}" -gt 0 ] || { echo "no Swift sources under $OCR_SRC" >&2; exit 1; }
swiftc -O -parse-as-library "${SWIFT[@]}" -o "$OCR_BIN"
echo "built $OCR_BIN"
