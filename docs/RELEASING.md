# How a PR becomes a version

**Your PR title is the input.** This repository squash-merges, so the title you
type becomes the one commit subject on `main`, and
[tools/next-version.sh](../tools/next-version.sh) reads exactly that. Nothing
else about the PR — branch name, body, commit subjects inside the branch —
affects the version.

Merging to `main` runs [the release workflow](../.github/workflows/release.yml):
it works out the next version, and if there is one, builds the app, creates the
tag, and publishes a GitHub release. There is no manual tagging step.

## What to write

| PR title starts with | Version | Example |
|---|---|---|
| `feat:` | **minor** — `0.4.2` → `0.5.0` | `feat: export looked-up words to Anki` |
| `docs:` `chore:` `ci:` `test:` `style:` | **nothing is released** | `docs: explain the voting gate` |
| anything else | **patch** — `0.4.2` → `0.4.3` | `perf: cache the window enumeration` |

"Anything else" is deliberate: `fix:`, `perf:`, `refactor:`, `Build(deps):` from
dependabot, and a plain English sentence all bump the patch. The rule errs
toward releasing, because a pipeline that silently stops releasing is a worse
failure than one extra version number.

A scope is fine and changes nothing: `feat(popup): …` bumps the minor exactly
like `feat: …`.

## Each digit, deliberately

**Patch** — the default. Write any title that isn't in the docs/chore list.

**Minor** — start the title `feat:`. Use it when the app can do something it
could not do before, not merely better or faster. A rewrite that makes lookups
twice as quick is `perf:`, and a patch.

**Major** — not automatic. `!` and `BREAKING CHANGE` bump the *minor* while the
major is 0, because declaring 1.0.0 is a claim about the project rather than
about one change. When you mean it:

```bash
git tag v1.0.0 && git push --tags
```

The next merge continues from there.

**Nothing** — prefix the title `docs:` or `chore:`. Worth doing on purpose: the
released app is unsigned, so macOS treats every release as a new application and
users re-grant Screen Recording and Accessibility each time. A README fix should
not cost anyone that.

## There is no digit rollover

`0.0.9` is followed by `0.0.10`, and `0.9.0` by `0.10.0`. The three numbers are
independent, not digits of one decimal — `sort -V`, GitHub's release ordering
and everything downstream assume that. Minor climbing past 9 is normal and means
nothing in particular.

## Checking before you merge

```bash
tools/next-version.sh              # what the next release would be, or "none"
tools/next-version.sh v0.3.1       # pretend that was the last tag
```

Run on a branch it reports what the branch's commits would produce. Since the
squash rewrites those into your PR title, treat it as a sanity check on the
rules rather than a prediction — the title is what counts.

## Publishing a specific version

Actions → Release → **Run workflow**, and give a tag such as `v1.0.0`. That
overrides the calculation entirely and releases whatever `main` currently is.

## What gets released

An Apple-silicon `.app` with the freely-licensed dictionaries inside
(Jitendex, JMnedict, KANJIDIC, Wiktionary JA→JA, JPDB and BCCWJ frequency), plus
`SHA256SUMS`. Commercial dictionaries are never published —
[build-release.sh](../tools/build-release.sh) refuses to package an index whose
manifest names one, so this cannot happen by forgetting.

Releases are built on a runner rather than a laptop for that reason: a clean
checkout can only obtain the free set, so the index is free by construction.
