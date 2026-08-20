# jp-verbs, vendored

| | |
|---|---|
| Upstream | https://github.com/mistval/jp-verb-deconjugator |
| Package | `jp-verbs` 1.1.0 (npm) |
| License | MIT — see [LICENSE](LICENSE), © 2017 mistval |
| Dependencies | none |

Vendored rather than depended on because the app ships no runtime
`node_modules`: `tools/build-release.sh` copies `app/vendor/` into the bundle
and nothing else. This is the same arrangement the Yomitan deinflector had
before it.

## Local changes

Four files the app never loads are not vendored: `index.d.ts`,
`word_type.d.ts`, `grammar_explanations.d.ts` (there is no TypeScript here)
and upstream's `README.md` (this file replaces it). `LICENSE` stays — MIT
requires the notice to travel with the copy.

Of what remains, one line differs, in `index.js`. Everything else is the
published package byte for byte, so re-vendoring a new release means
re-applying this hunk and nothing else:

```diff
   const isDictionaryForm =
     wordType === WordType.GODAN_VERB ||
     wordType === WordType.ICHIDAN_VERB ||
+    wordType === WordType.ADJECTIVE ||
     wordType === WordType.SENTENCE;
```

`derivations.js` carries 44 adjective rules — `くない`, `かった`, `くて`,
`ければ`, `かったら` and the rest — and upstream walks all of them. It then
drops every result, because `ADJECTIVE` is not in the set of word types that
count as a finished deinflection: the package is called jp-**verbs**.

Measured, before and after the line:

```
高くない        => (nothing)        => 高い
高かった        => (nothing)        => 高い
美味しくなかった  => (nothing)        => 美味しい
面白くて        => (nothing)        => 面白い
信じられている   => 信じる           => 信じる      (unchanged)
```

Verb output is unchanged; the diff only adds terminal states that were
previously computed and thrown away.

## Upstreaming

Worth offering back — it is a one-line fix to dead work in their own table.
Not done yet.
