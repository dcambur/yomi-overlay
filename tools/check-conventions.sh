#!/bin/bash
# Rules from docs/CONVENTIONS.md that a machine can check.
#
# Not a linter. Each of these is a specific mistake that has either happened
# here or would quietly undo something the codebase depends on, and each one is
# cheap to detect. Style is left to review.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/paths.sh"
cd "$PROJECT_ROOT" || exit 2

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; shift; printf '        %s\n' "$@"; fail=1; }

# --- the app bundle holds only the loader (ARCHITECTURE section 6) -----------
# electron-packager copies app/shell wholesale. Anything parked there is baked
# into the signed bundle, which is what the loader trick exists to avoid.
extra=$(find app/shell -mindepth 1 -maxdepth 1 \
        ! -name 'bootstrap.js' ! -name 'package.json' -print)
if [ -z "$extra" ]; then ok "app/shell holds only the loader"
else bad "app/shell has extra files — they would be baked into the .app" "$extra"; fi

# --- one file per language knows the layout ---------------------------------
# A second place that hardcodes a directory is how a move breaks in the one
# path nobody tests.
stray=$(grep -rn "path.join(__dirname" app --include='*.js' \
        | grep -v node_modules | grep -v 'app/paths.js' || true)
if [ -z "$stray" ]; then ok "no __dirname path building outside paths.js"
else bad "directories resolved outside the resolver" "$stray"; fi

# --- main.js is wiring ------------------------------------------------------
n=$(grep -c '^let ' app/main.js || true)
if [ "$n" = "0" ]; then ok "app/main.js holds no module-scope mutable state"
else bad "app/main.js has $n module-scope 'let' — it belongs in a module"; fi

# --- the renderer stays sandboxable ----------------------------------------
if grep -q "nodeIntegration: true" -r app --include='*.js'; then
  bad "nodeIntegration: true — this also disables the sandbox"
else ok "nodeIntegration is never enabled"; fi

# The meta tag only — the comment above it says the words on purpose.
if grep 'http-equiv="Content-Security-Policy"' app/renderer/index.html \
   | grep -q "unsafe-inline"; then
  bad "renderer CSP allows unsafe-inline again"
else ok "renderer CSP has no unsafe-inline"; fi

# --- docs point at files that exist ----------------------------------------
broken=$(cd docs && for f in *.md history/*.md; do
  grep -oE '\]\((\.\./)*[A-Za-z0-9_][A-Za-z0-9_./@-]*\)' "$f" | sed 's/](//;s/)$//' |
  while read -r l; do d=$(dirname "$f"); [ -e "$d/$l" ] || echo "$f -> $l"; done
done)
if [ -z "$broken" ]; then ok "every doc link resolves"
else bad "broken doc links" "$broken"; fi

# --- shell scripts are bash 3.2 safe ---------------------------------------
# macOS ships bash 3.2. mapfile/readarray are bash 4 and fail at run time, not
# at parse time, so nothing else catches this.
# Code only: both this check and ocr/build.sh name them in comments.
b4=$(grep -rn '^[^#]*\b\(mapfile\|readarray\)\b' --include='*.sh' . 2>/dev/null \
     | grep -v node_modules | grep -v check-conventions || true)
if [ -z "$b4" ]; then ok "no bash 4 builtins (macOS ships 3.2)"
else bad "bash 4 builtins used" "$b4"; fi

# --- workflows can actually run what they name ------------------------------
# A repo script invoked bare (`run: tools/x.py`) needs its executable bit
# committed. git tracks that bit, a local chmod is easy to forget, and nothing
# fails until the workflow runs — which for the release workflow means after a
# merge, on main. Measured: `tools/build-index.py: Permission denied`, release
# run 31815845246. Invoking through an interpreter sidesteps the bit entirely
# and is what setup.sh already does, so either form passes.
notexec=$(grep -hoE '^ *run: [a-z]+/[a-z0-9-]+\.(sh|py)' .github/workflows/*.yml 2>/dev/null |
  sed 's/^ *run: //' | sort -u |
  while read -r s; do
    [ "$(git ls-files -s "$s" 2>/dev/null | awk '{print $1}')" = "100755" ] || echo "$s"
  done)
if [ -z "$notexec" ]; then ok "workflows only invoke executable scripts bare"
else bad "invoked bare but not executable in git (chmod +x, or call via python3/bash)" "$notexec"; fi

exit $fail
