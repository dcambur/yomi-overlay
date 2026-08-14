#!/bin/bash
# The next release tag, worked out from the commits since the last one.
#
#   tools/next-version.sh            # -> v0.2.0, or "none"
#   tools/next-version.sh v0.1.3     # pretend that was the last tag (testing)
#
# Semantic versioning, decided by commit subject, because this project already
# writes conventional-ish subjects and a version derived from them costs nobody
# a decision at release time:
#
#   feat: …           minor        a capability that was not there before
#   anything else     patch        fixes, perf, refactors, dependency bumps
#   docs/chore/ci/…   nothing      no release at all
#
# Two deliberate departures from the usual rules:
#
# - An UNKNOWN prefix bumps the patch rather than being ignored. The history
#   here is mixed (`Build(deps):` from dependabot, plain sentences from before
#   the convention), and the failure mode of the strict rule is a pipeline that
#   silently stops releasing. Erring toward a release is the cheaper mistake.
#
# - `!` and BREAKING CHANGE bump the MINOR while the major is 0. Going to 1.0.0
#   is a statement about the project, not about one commit, so it stays manual:
#   tag v1.0.0 by hand when you mean it.
#
# There is no digit rollover. 0.0.9 is followed by 0.0.10 — versions are three
# independent numbers, not one decimal, and `sort -V`, GitHub and every tool
# downstream assume that.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."

LAST="${1:-$(git tag --list 'v*' --sort=-v:refname | head -1)}"

if [ -z "$LAST" ]; then
  # Nothing has ever been released. 0.1.0 rather than 0.0.1: the first
  # downloadable build is a milestone, and 0.0.x reads like it does not run.
  echo "v0.1.0"
  exit 0
fi

RANGE="$LAST..HEAD"
git rev-parse "$LAST" >/dev/null 2>&1 || { echo "no such tag: $LAST" >&2; exit 2; }

SUBJECTS="$(git log --format='%s' "$RANGE")"
[ -n "$SUBJECTS" ] || { echo "none"; exit 0; }

BUMP=""
while IFS= read -r s; do
  [ -n "$s" ] || continue
  case "$s" in
    # A capability that was not there before.
    feat:*|feat\(*\):*|feat!:*|feat\(*\)!:*) BUMP="minor" ;;
    # Prose and plumbing. Never worth making a user re-grant permissions for.
    docs:*|docs\(*\):*|chore:*|chore\(*\):*|ci:*|ci\(*\):*|test:*|test\(*\):*|style:*|style\(*\):*)
      [ -n "$BUMP" ] || BUMP="" ;;
    *) [ "$BUMP" = "minor" ] || BUMP="patch" ;;
  esac
done <<< "$SUBJECTS"

# A breaking marker anywhere in the range, body included.
if git log --format='%s%n%b' "$RANGE" | grep -qE '^[a-zA-Z]+(\(.+\))?!:|BREAKING[ -]CHANGE'; then
  BUMP="minor"
fi

[ -n "$BUMP" ] || { echo "none"; exit 0; }

# Refuse to do arithmetic on something that is not a version. Without this a
# tag like `release-2` walks into $(( )) as a variable name and either expands
# to 0 — silently releasing v0.1.0 over the top of history — or trips `set -u`
# with a message that names a shell variable rather than the real problem.
case "$LAST" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "last tag '$LAST' is not vMAJOR.MINOR.PATCH" >&2; exit 2 ;;
esac

V="${LAST#v}"
MAJOR="${V%%.*}"; REST="${V#*.}"; MINOR="${REST%%.*}"; PATCH="${REST#*.}"
case "$BUMP" in
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
echo "v$MAJOR.$MINOR.$PATCH"
