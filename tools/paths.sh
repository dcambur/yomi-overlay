#!/bin/bash
# Where everything lives, for the shell scripts. Source this; don't run it.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/paths.sh"
#
# The counterpart to paths.js and paths.py, for the same reason: a literal path
# only ever describes one machine.
#
# *** The only line that knows the layout is PROJECT_ROOT. *** If this file
# moves to a different depth, that is the one line to change.

_PATHS_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This file sits one level below the checkout root.
PROJECT_ROOT="$(cd "$_PATHS_SH_DIR/.." && pwd)"

APP_DIR="$PROJECT_ROOT/app"
DATA_DIR="$PROJECT_ROOT/data"
TOOLS_DIR="$PROJECT_ROOT/tools"
BIN_DIR="$PROJECT_ROOT/bin"
VENV_DIR="$DATA_DIR/.venv"
# electron-packager copies this directory wholesale into the .app, so nothing
# but the loader may live here — see ARCHITECTURE section 6.
SHELL_DIR="$APP_DIR/shell"

OCR_SRC="$PROJECT_ROOT/ocr/Sources"
OCR_BIN="$BIN_DIR/kindleocr"

export PROJECT_ROOT APP_DIR DATA_DIR TOOLS_DIR VENV_DIR BIN_DIR SHELL_DIR \
       OCR_SRC OCR_BIN
