"""Where everything lives, for the Python build scripts.

The counterpart to paths.js, and it exists for the same reason: a literal path
only ever describes one machine. Every root is derived from this file's own
location, so a clone or a move needs no edit.

*** The only line that knows the layout is PROJECT_ROOT. *** If this file moves
to a different depth, that is the one line to change; nothing else here or in
any consumer refers to a directory name.
"""

from pathlib import Path

# This file sits one level below the checkout root.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

APP_DIR = PROJECT_ROOT / "overlay"
DATA_DIR = APP_DIR
TOOLS_DIR = APP_DIR
BIN_DIR = PROJECT_ROOT

DICTS = DATA_DIR / "dicts"
INDEX_DB = DATA_DIR / "index.db"
MANIFEST = DATA_DIR / "dictionaries.json"
CONFIG = DATA_DIR / "config.json"
OCR_BIN = BIN_DIR / "kindleocr"
