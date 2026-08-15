#!/bin/bash
# Every check that can be made without running the app.
#
# ONE script, called by the pre-commit hook and by CI, so the two cannot drift:
# the way to find out whether something will pass on the runner is to run the
# same thing the runner runs.
#
#   tools/lint.sh            everything available on this machine
#   tools/lint.sh js         eslint only
#   tools/lint.sh swift      swift-format only (macOS)
#   tools/lint.sh --fix      eslint --fix, swift-format --in-place
#
# What is checked, and by what:
#
#   JavaScript   eslint, config in eslint.config.js — layout AND correctness
#                (undefined variables, unused bindings, shadowing)
#   Swift        swift-format, config in .swift-format. Layout only — type
#                checking is the COMPILER's job, and that is what ocr/build.sh
#                does in CI. NOT part of the CI gate: swift-format ships with
#                Xcode, so a runner and a laptop disagree on line breaks by
#                toolchain version alone, and a check that fails on which Xcode
#                you have is a check nobody can act on. It runs here, before
#                the commit, where one developer's version is consistent with
#                itself.
#   Python       py_compile — syntax, which is all that can be had without a
#                type checker the project does not use
#   Shell        bash -n, plus shellcheck when it is installed
#   Conventions  tools/check-conventions.sh — the project's own structural
#                rules, the ones no general linter knows about
#
# A missing tool is reported and skipped, never silently passed over: a check
# that quietly does not run is worse than no check, which is the lesson the
# test suite already learned.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1

WHICH=all
FIX=""
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    js|swift|python|shell|conventions|all) WHICH="$arg" ;;
    *) echo "usage: tools/lint.sh [js|swift|python|shell|conventions|all] [--fix]" >&2
       exit 2 ;;
  esac
done

rc=0
run() { [ "$WHICH" = all ] || [ "$WHICH" = "$1" ]; }
fail() { echo "  ✗ $1"; rc=1; }
ok() { echo "  ✓ $1"; }

if run js; then
  echo "== javascript =="
  if [ -x node_modules/.bin/eslint ]; then
    # shellcheck disable=SC2086
    if node_modules/.bin/eslint app test eslint.config.js ${FIX:+--fix}; then
      ok "eslint"
    else
      fail "eslint"
    fi
  else
    fail "eslint not installed — run: npm install"
  fi
fi

if run swift; then
  echo "== swift =="
  if [ "$(uname)" != Darwin ]; then
    echo "  – swift-format is macOS only, skipped"
  elif ! xcrun --find swift-format >/dev/null 2>&1; then
    fail "swift-format not found — install the Xcode command line tools"
  elif [ -n "$FIX" ]; then
    xcrun swift-format format --in-place -r ocr/Sources && ok "swift-format (rewrote)"
  elif xcrun swift-format lint --strict -r ocr/Sources; then
    ok "swift-format"
  else
    fail "swift-format (run: tools/lint.sh swift --fix)"
  fi
fi

if run python; then
  echo "== python =="
  files=$(find tools test -name '*.py' -not -path '*/node_modules/*')
  # shellcheck disable=SC2086
  if python3 -m py_compile $files; then ok "py_compile"; else fail "py_compile"; fi
fi

if run shell; then
  echo "== shell =="
  if find . -name '*.sh' -not -path './node_modules/*' -not -path '*/node_modules/*' \
       -exec bash -n {} \; ; then
    ok "bash -n"
  else
    fail "bash -n"
  fi
  if command -v shellcheck >/dev/null 2>&1; then
    # -exec, not $(find), so a path with a space cannot split into two.
    if find . -name '*.sh' -not -path '*/node_modules/*' \
         -exec shellcheck -S warning {} +; then
      ok "shellcheck"
    else
      fail "shellcheck"
    fi
  else
    echo "  – shellcheck not installed, skipped (CI runs it)"
  fi
fi

if run conventions; then
  echo "== conventions =="
  if tools/check-conventions.sh >/dev/null; then
    ok "check-conventions.sh"
  else
    tools/check-conventions.sh | grep -v '^  ok'
    fail "check-conventions.sh"
  fi
fi

[ $rc -eq 0 ] && echo "all checks passed"
exit $rc
