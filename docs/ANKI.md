# Anki: one click on a popup card, one Lapis note

The design record for the Anki integration (PLAN.md Stage 4, first half). Read
[ARCHITECTURE](ARCHITECTURE.md) and [CONVENTIONS](CONVENTIONS.md) first; the
decisions below stay inside them.

## What it does

Every headword card in the popup carries a small card mark at the right of
its headword line. Click it and a **Lapis** note for that word lands in the
deck chosen in Settings → Anki, with the sentence under the cursor, the
definitions the popup is showing, pitch, frequency, and a picture of the
sentence's region of the target window. If the word is already in that deck
the mark is filled in and clicking it removes the note again.

Nothing is configurable about the note type: it is Lapis, by field name,
because that is the note type the popup's data maps onto without a mapping
editor. Lapis is a free note type (<https://github.com/donkuri/lapis>, GPL-3.0);
when Anki does not have it, the popup's marks say `no Lapis` and Settings → Anki
installs it with one button (decision 7).

## What was measured before designing

- **This machine's collection** (read from a copy of `collection.anki2`,
  2026-09-19): note type `Lapis`, 22 fields in this order — Expression,
  ExpressionFurigana, ExpressionReading, ExpressionAudio, SelectionText,
  MainDefinition, DefinitionPicture, Sentence, SentenceFurigana, SentenceAudio,
  Picture, Glossary, Hint, IsWordAndSentenceCard, IsClickCard, IsSentenceCard,
  IsAudioCard, PitchPosition, PitchCategories, Frequency, FreqSort, MiscInfo.
  7,196 existing notes, all with `<b>word</b>` in Sentence,
  Yomitan-shaped HTML in Glossary (`<div class="yomitan-glossary"><ol><li
  data-dictionary="…">`), a bare integer in Frequency and FreqSort
  (`9999999` for "no frequency", 239 notes), and the tags `yomitan` +
  a per-book tag. The same shapes are what Lapis's own README asks Yomitan
  to produce.
- **The Lapis card template** (same collection): the pitch number is read
  off `#pitch-tags` with `/\d+/`, so `[0]` is enough; `PitchCategories`
  empty makes the card derive heiban/atamadaka/nakadaka/odaka itself,
  including the verb-ending → kifuku rule we cannot decide better;
  `ExpressionFurigana` goes through Anki's `{{furigana:}}` and `{{kana:}}`
  filters, so it must be the bracket form `小遣[こづか]い 稼[かせ]ぎ`
  (space before every bracketed group but the first — Yomitan's
  `{furigana-plain}`), not `<ruby>`; `Frequency` is shown as-is when it
  contains a `<ul>`; the card's CSS keys on `li[data-dictionary]`.
- **AnkiConnect** (add-on 2055492159 installed, default config:
  `127.0.0.1:8765`, no API key, `webCorsOriginList: ["http://localhost"]`).
  `plugin/web.py`: a request with **no `Origin` header is always allowed** —
  a `fetch` from Electron's main process sends none, so there is no
  permission dialog and no CORS list to edit. A renderer window would send
  `file://`'s null origin and get 403 on everything, which is one more
  reason the client lives in main.
- Error strings the client keys on (`plugin/__init__.py`): `cannot create
  note because it is a duplicate`, `model was not found: …`, `deck was not
  found: …`, `cannot create note because it is empty`.

## Where things live

| Piece | Owns |
|---|---|
| [app/main/anki.js](../app/main/anki.js) | the AnkiConnect client (`fetch`, one timeout, `multi`), the Lapis note builder, the deck-scoped duplicate search |
| [app/renderer/sentence.js](../app/renderer/sentence.js) | the sentence containing a glyph: block-aware, crosses line breaks inside a paragraph or bubble, stops at 。！？ |
| [app/renderer/popup.js](../app/renderer/popup.js) | the card mark on each headword line, and the note it asks main to build — the definitions come from the DOM it already rendered |
| [app/renderer/renderer.js](../app/renderer/renderer.js) | when the marks are asked about (once per popup) and what a click means |
| [app/settings/settings.js](../app/settings/settings.js) | the Anki tab: on/off, status, deck, tags, picture |
| [app/main/crop.js](../app/main/crop.js) | `requestCrop`: the JS end of the watch process's crop channel |

## The decisions

### 1. Definitions come from the popup's DOM, not from the index

`structured.js` already turns each dictionary's structured content into DOM
for the popup; the index holds the raw structure, and main would need a second
renderer to make HTML of it. So the renderer builds the Glossary and
MainDefinition fields by cloning the entries it drew — every `<img>` replaced
by its label, because Anki cannot fetch `yomi-media:` — and wraps them in
Yomitan's shape (`<div class="yomitan-glossary"><ol><li data-dictionary="…">`)
so Lapis's stylesheet applies. Main caps the size and passes it through;
it is the user's own collection, and the renderer runs our own code.

MainDefinition is the first monolingual dictionary's entries when one is
enabled, else empty; Glossary is every entry except names and kanji, in the
popup's order. Lapis hides from Glossary any dictionary already shown in
MainDefinition, so both can be full.

### 2. The sentence walks the block, not the line

A line is where the page wrapped, not where the sentence ended: a novel
sentence spans two or three lines, a manga bubble several. `sentence.js`
groups lines into blocks (same orientation, sharing ≥30% of the cross axis,
flow gap under 1.8× the page's median gap, both lines mostly kana/kanji)
and walks back and forward inside the block to the nearest 。！？. The
thresholds and the reason for each are in the file; they were measured on the
`page-a`/`page-b` fixtures for the sentence-explain feature and moved here
unchanged so the two features slice the same sentence.

The matched glyph run is wrapped in `<b>` — Lapis colours it by pitch and the
audio card hides it — and everything else is HTML-escaped.

### 3. The picture is a crop from the watch process

Re-capturing would need a second ScreenCaptureKit session, which stalls
(CONVENTIONS, gotchas). The watch process serves crops of its last frame
over stdin (built for the tier-2 probe, since removed), so the picture is
that: the sentence's glyph boxes, padded by one glyph size, upscaled 2× as
every crop is. Main
waits up to 3s for it and adds the note without a picture if it does not
come — a card without a picture is still a card; a card that never arrives
is not.

### 4. Duplicates are per deck, and the deck is the truth

`addNote` runs with `allowDuplicate: false, duplicateScope: 'deck'`, so the
same word in another deck is a new note here. Whether a word is already in
the deck is asked from Anki (`findNotes "deck:…" "note:Lapis" "expression:…"`,
one `multi` call for all the popup's cards) rather than remembered locally:
the note may have been deleted in Anki since. The search value has Anki's
wildcards and separators escaped (`\ * _ : " ( )`), because a headword can
contain any of them.

### 5. The client is main-process only, and `enabled` gates every call

One `fetch` per action with a 3s timeout (10s for `addNote`, which may be
downloading a picture); no retries, no polling. The overlay asks about a
popup's words once per popup, and only while Anki is enabled in Settings;
a failed connection is reported on the mark, not retried per hover. Nothing
in the renderer can reach the network — its CSP stays `default-src 'none'`.

### 6. The mark says what stops a card, before it is clicked

`find` asks `modelNames` and `deckNames` in the same `multi` as the searches,
because a search for `note:Lapis` in a collection without Lapis answers
"none": the mark offered an add that could only fail, and said so only in a
tooltip after the click. Every refusal from `anki.js` carries a reason, and
three of them are states of the mark, named in its label — a title shows only
after a hover:

| Reason | Mark | A click |
|---|---|---|
| `offline` — nothing at AnkiConnect's address | `Anki closed` | asks again, for every card |
| `model` — no Lapis | `no Lapis` | opens Settings on the Anki tab |
| `deck` — none chosen, or gone from Anki | `no deck` | opens Settings on the Anki tab |

All three draw the same card outline struck through once, in the chip's
colour: nothing is wrong with the word, and the warm red is kept for a note
about to be deleted. Anything else is the `error` state, in the client's words.

### 7. Installing Lapis makes the note type, not the package

AnkiConnect's `importPackage` runs Anki's legacy importer, which reads
`collection.anki2` from an `.apkg`. In Lapis 1.7.0's release that file has no
Lapis at all — one note, "Please update to the latest Anki version" — and the
real collection (`collection.anki21b`) also carries a `Lapis` deck with an
example note and five media files (measured 2026-09-24). So the button does
what Lapis's own build does (`build/genapkg.py`): one template, `Mining`, from
`src/front.html` and `src/back.html`, the stylesheet `src/styling.css`, and the
22 fields, made with `createModel`. The three files are fetched from the `1.7.0`
tag on GitHub and checked against pinned SHA-256 digests, so a file changed
under the tag is refused, not installed; they are GPL-3.0 and are never shipped
with the app. Measured the same day: the tag's files are the release's note
type byte for byte but for trailing whitespace Anki trims, and a note type made
from them with `createModel`'s own steps in a scratch collection (Anki 25.07.5)
renders a `lapisFields` note with no template error.

Nothing else is written: no deck, no note, no media. The note type gets a new
id rather than the release's, so importing a later `Lapis.apkg` over it is
Anki's usual note-type import, not an in-place update.

## Note fields, and where each comes from

| Lapis field | Value |
|---|---|
| Expression | dictionary form (`base`, or the surface when uninflected) |
| ExpressionFurigana | bracket furigana of Expression from the entry's reading; empty when Expression is all kana |
| ExpressionReading | the entry's reading |
| MainDefinition | first enabled monolingual dictionary's entries as Yomitan-shaped HTML, or empty |
| Glossary | every entry but names and kanji, same shape |
| Sentence | the block sentence with `<b>` around the matched glyphs |
| Picture | `<img src="…">` appended by AnkiConnect from the crop, when the crop arrived |
| PitchPosition | `[N]` for every accent of the shown reading, e.g. `[0] [3]` |
| Frequency | `<ul style="text-align: left;"><li>JPDB: 14171</li>…</ul>` |
| FreqSort | floor of the harmonic mean of the ranks; `9999999` when there are none |
| IsWordAndSentenceCard | `1` — the sentence shows on the front as a hint, matching every existing note here |
| tags | from Settings (default `yomi-overlay`) |
| everything else | empty: audio has no licensed source (PLAN.md Stage 4 names `AVSpeechSynthesizer` as the follow-up), SentenceFurigana is the AJT add-on's job per Lapis's README, Hint/MiscInfo/SelectionText are the reader's |

## Settings → Anki

Saved live, like the trigger tab: nothing restarts. The tab shows a status
row with the same dot vocabulary the window picker uses — green `Ready`;
amber `No Lapis`; grey `Not running` — with the one thing to do about it
after the state, and nothing after `Ready`. With `No Lapis` a second row says
what installing adds (fields, template, styling; no deck, no notes) beside an
`Install Lapis` button; while it runs, the dictionary tab's indeterminate bar,
and after a failure the reason, with the button still there. The popup's
`no Lapis` and `no deck` marks open the window on this tab. Then the deck list, drawn as the
tree Anki's own deck browser shows: `deckNames` lists every level of
`Parent::Child`, and flat that was 18 rows of repeated prefixes on this
machine (3 roots). A parent folds its subdecks and says how many it hides;
the folds start closed except along the path to the chosen deck; a closed
parent with the chosen deck inside keeps the accent on its name, so the
choice is never out of sight. Which folds are open is not a setting and is
not saved. Clicking a name chooses it; the deck list is refreshed when the
tab is shown. Then the tags and the picture switch. `anki.url` and
`anki.key` are edit-and-restart keys in `config.json` for an AnkiConnect
that was moved or locked; the defaults are the add-on's.

## Tests

- `test/unit/anki.test.js` — the note builder against known words
  (信じ切る → `信[しん]じ 切[き]る`, 十中八九 → `十中八九[じっちゅうはっく]`, a
  kana word → empty), the search escaping, the harmonic rank, and the client
  against a local HTTP double that answers like AnkiConnect (add → find →
  delete, duplicate refusal, model missing, connection refused); the reason
  on every refusal; the install — exactly `modelNames` then `createModel`
  with the 22 fields and the `Mining` template, nothing fetched when Lapis is
  there, a file whose digest differs refused before Anki is touched.
- `test/unit/sentence.test.js` — sentences sliced from the real `page-a`
  and `page-b` payloads: crosses a wrapped line, stops at the paragraph gap,
  never leaves a column.
- `test/unit/renderer.js` — the mark is drawn only when Anki is enabled, and
  a click sends main a note whose Sentence bolds the matched glyphs; `no
  Lapis` is shown before a click and opens Settings, `Anki closed` asks again,
  an add refused for its deck turns to `no deck`, and the strike is read from
  the computed `::after`, not the class.
- `test/unit/settings.js` — the tab renders decks from the bridge and saves
  a deck choice without a button; the install row appears only with `No
  Lapis`, shows its bar while installing, says why it failed, and main can
  ask for the tab.

## Gates

`tools/lint.sh`, `test/run.sh`. No Swift changed, so golden is
unaffected. The by-hand check: Anki open with Lapis imported, pick a deck in
Settings → Anki, look up a word, click the mark, open the note in Anki.

## Not done, on purpose

- Audio. No licensed source yet; Stage 4's plan is `AVSpeechSynthesizer`.
- Opening the note in Anki's browser from the popup (`guiBrowse nid:`).
  Cheap, but a second control on a mark that already has two states.
- Field mapping for other note types. Lapis is the contract.
