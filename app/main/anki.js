// Anki: the AnkiConnect client and the Lapis note it builds. docs/ANKI.md has
// the design and the measurements; this file is the contract.
//
// Main process only. AnkiConnect allows any request that carries no Origin
// header (plugin/web.py, allowOrigin), which is what a fetch from here sends,
// so there is no permission dialog and no CORS list to edit — and the
// renderer's CSP stays default-src 'none'.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { logf } = require('./log.js');

/** The note type, by name. The field names below are Lapis's own. */
const MODEL = 'Lapis';
/** Lapis's fields in its own order (build/anki_fields.yaml at 1.7.0). */
const LAPIS_FIELDS = [
  'Expression', 'ExpressionFurigana', 'ExpressionReading', 'ExpressionAudio',
  'SelectionText', 'MainDefinition', 'DefinitionPicture', 'Sentence',
  'SentenceFurigana', 'SentenceAudio', 'Picture', 'Glossary', 'Hint',
  'IsWordAndSentenceCard', 'IsClickCard', 'IsSentenceCard', 'IsAudioCard',
  'PitchPosition', 'PitchCategories', 'Frequency', 'FreqSort', 'MiscInfo',
];
// Where the Lapis note type comes from when Settings installs it: the three
// files its release is built from (build/genapkg.py — one template, "Mining",
// from front.html and back.html, and styling.css), at a tag, each checked
// against its digest. Not Lapis.apkg: AnkiConnect's importPackage runs Anki's
// legacy importer, which reads collection.anki2 from the package, and in
// 1.7.0 that file holds no Lapis at all — only a note saying "Please update
// to the latest Anki version" (measured 2026-09-24). The package would also
// bring a "Lapis" deck with an example note. The files are GPL-3.0 and are
// fetched from the project, never shipped with the app. Measured the same
// day: they are the release's note type byte for byte, but for the trailing
// whitespace Anki trims.
const LAPIS_SOURCE = {
  tag: '1.7.0',
  base: 'https://raw.githubusercontent.com/donkuri/lapis/1.7.0/src/',
  sha256: {
    'front.html': '7bb9993df961d35e7f49b3edec9f7b0f43987f114f3cfdc627a10219c62aef49',
    'back.html': '1d92182a7626b8a14fd80bc82ee07e71a7a387533be3a4124d25fe8b3090a137',
    'styling.css': '51590e7545d43896cb15e494db49b611a9c6e7bbf05c8e0debbf1f98f7ae8920',
  },
};
// Three files of 3-26 KB from GitHub's raw host.
const SOURCE_TIMEOUT_MS = 15000;
/** Yomitan's rank for "no frequency list knows this word"; Lapis sorts on it. */
const NO_FREQUENCY = 9999999;
// A running Anki answers deckNames in well under a second; 3s is for a machine
// under load. addNote can be reading a picture off disk, so it gets longer.
const TIMEOUT_MS = 3000;
const ADD_TIMEOUT_MS = 10000;
// A crop is served on the next watch pass: up to one interval (0.6s by
// default) plus an OCR pass on a busy page. Past 3s the card goes without —
// a card with no picture is still a card; a card that never arrives is not.
const CROP_WAIT_MS = 3000;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Hiragana, katakana, half-width katakana, and the long-vowel mark.
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;
const toHiragana = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * Bracket furigana, Yomitan's {furigana-plain}: 小遣い稼ぎ/こづかいかせぎ →
 * `小遣[こづか]い 稼[かせ]ぎ`. Kanji runs get their share of the reading in
 * brackets, kana in the term stays as it is, and every bracketed run but the
 * first is preceded by a space so Anki's furigana filter knows where it
 * starts. Lapis reads the field back through that filter and `{{kana:}}`, so
 * this — not <ruby> — is the shape it needs (its README says so too).
 *
 * The reading is split by finding each kana run of the term in it, left to
 * right, each kanji run taking at least one kana. That is what Yomitan does
 * for the common case; when the kana cannot be found where they should be
 * the whole term takes the whole reading, which is still a correct card.
 */
function furiganaPlain(term, reading) {
  const t = String(term), r = String(reading || '');
  if (!r || !Array.from(t).some((c) => !KANA.test(c))) return '';
  const whole = `${t}[${r}]`;
  const runs = [];
  for (const c of t) {
    const kana = KANA.test(c);
    const last = runs[runs.length - 1];
    if (last && last.kana === kana) last.text += c;
    else runs.push({ kana, text: c });
  }
  const rh = toHiragana(r);
  let pos = 0;
  const parts = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.kana) {
      const k = toHiragana(run.text);
      if (!rh.startsWith(k, pos)) return whole;
      parts.push(run.text);
      pos += k.length;
      continue;
    }
    const next = runs[i + 1];
    const end = next ? rh.indexOf(toHiragana(next.text), pos + 1) : rh.length;
    if (end <= pos) return whole;
    parts.push(`${parts.length ? ' ' : ''}${run.text}[${r.slice(pos, end)}]`);
    pos = end;
  }
  return pos === rh.length ? parts.join('') : whole;
}

/**
 * Yomitan's {frequency-harmonic-rank}: the harmonic mean of every list's
 * rank, floored. One very common list and one rare one land nearer the
 * common one, which is what a "how common" number should do.
 */
function harmonicRank(values) {
  const ranks = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!ranks.length) return NO_FREQUENCY;
  return Math.floor(ranks.length / ranks.reduce((s, v) => s + 1 / v, 0));
}

/**
 * A value inside a quoted Anki search term. Backslash escapes; * and _ are
 * wildcards, : separates a field from its value, quotes delimit, parentheses
 * group, and a leading - negates — a headword can contain any of them.
 */
function searchValue(s) {
  return String(s).replace(/[\\"*_:()]/g, (c) => '\\' + c).replace(/^-/, '\\-');
}

/** The Lapis fields for one card the popup described. Empty means empty. */
function lapisFields(note) {
  const expression = String(note.expression);
  const reading = String(note.reading || '');
  const freq = (note.freq || []).filter((f) =>
    f && typeof f.source === 'string' && Number.isFinite(f.value));
  const pitch = (note.pitch || []).filter(Number.isInteger);
  const list = freq.map((f) => `<li>${esc(f.source)}: ${esc(f.value)}</li>`).join('');
  return {
    Expression: expression,
    ExpressionFurigana: furiganaPlain(expression, reading),
    ExpressionReading: reading,
    MainDefinition: String(note.mainDefinition || ''),
    Sentence: String(note.sentence || ''),
    Glossary: String(note.glossary || ''),
    // The sentence shows on the front as a hint: every note in the collection
    // this was measured against is this kind, and a word alone on the front
    // of a card mined from a page throws the page away.
    IsWordAndSentenceCard: '1',
    // Lapis takes the digits out of this with /\d+/, so the bare notation is
    // enough; several accents are several brackets.
    PitchPosition: pitch.map((p) => `[${p}]`).join(' '),
    Frequency: list ? `<ul style="text-align: left;">${list}</ul>` : '',
    FreqSort: String(harmonicRank(freq.map((f) => f.value))),
  };
}

const NO_MODEL = `the ${MODEL} note type is not in Anki — install it in Settings → Anki`;
const noDeck = (deck) => `deck "${deck}" is not in Anki`;

/**
 * What stands between the user and a card, as the popup's mark shows it:
 * `offline` (Anki is not running), `model` (no Lapis), `deck` (no deck
 * chosen, or the chosen one is gone), `off` (Anki is off in Settings), or
 * `error` for anything else, which is shown in the client's own words.
 */
function failure(e, deck) {
  if (e.reason) return { ok: false, reason: e.reason, error: e.message };
  if (/model was not found/.test(e.message)) return { ok: false, reason: 'model', error: NO_MODEL };
  if (/deck was not found/.test(e.message)) {
    return { ok: false, reason: 'deck', error: noDeck(deck) };
  }
  return { ok: false, reason: 'error', error: e.message };
}

/**
 * The client. `cfg.anki()` is read per call, so a change in Settings applies
 * to the next request; `requestCrop(rect, file, waitMs)` is the watch
 * process's crop channel (tier2.js), and may be absent in a test.
 */
function createAnki({ cfg, requestCrop, lapisSource = LAPIS_SOURCE }) {
  async function invoke(action, params, timeoutMs = TIMEOUT_MS) {
    const a = cfg.anki();
    const body = { action, version: 6, params: params || {} };
    if (a.key) body.key = a.key;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(a.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`Anki did not answer within ${timeoutMs / 1000}s`);
      }
      const code = e.cause && e.cause.code;
      if (code === 'ECONNREFUSED') {
        throw Object.assign(new Error(`Anki is not running (nothing at ${a.url})`),
                            { reason: 'offline' });
      }
      throw new Error(`Anki: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`AnkiConnect answered ${res.status}`);
    const reply = await res.json();
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  }

  /** Several actions in one round trip. Each needs its own version and key. */
  async function multi(actions) {
    const a = cfg.anki();
    const replies = await invoke('multi', {
      actions: actions.map(([action, params]) => ({
        action, version: 6, params: params || {}, ...(a.key ? { key: a.key } : {}),
      })),
    });
    return replies.map((r) => {
      if (r && r.error) throw new Error(r.error);
      return r ? r.result : r;
    });
  }

  const query = (deck, expression) =>
    `"deck:${searchValue(deck)}" "note:${MODEL}" "expression:${searchValue(expression)}"`;

  /** Is Anki up, does it have Lapis, and which decks are there. */
  async function status() {
    const a = cfg.anki();
    const base = { enabled: a.enabled, deck: a.deck };
    try {
      const [version, models, decks] =
        await multi([['version'], ['modelNames'], ['deckNames']]);
      return { ...base, running: true, version, model: models.includes(MODEL), decks };
    } catch (e) {
      return { ...base, running: false, error: e.message };
    }
  }

  function gate() {
    const a = cfg.anki();
    if (!a.enabled) return 'Anki is off in Settings';
    if (!a.deck) return 'no deck chosen in Settings → Anki';
    return null;
  }
  const refusal = (why) =>
    ({ ok: false, reason: cfg.anki().enabled ? 'deck' : 'off', error: why });

  /**
   * The note id each word already has in the chosen deck, or null — or what
   * stops a card being made at all. That is asked in the same round trip: a
   * search for `note:Lapis` in a collection without Lapis answers "none", and
   * the mark would offer an add that can only fail.
   */
  async function find(expressions) {
    const refused = gate();
    if (refused) return refusal(refused);
    const a = cfg.anki();
    try {
      const searches = expressions.map((x) => ['findNotes', { query: query(a.deck, x) }]);
      const [models, decks, ...lists] =
        await multi([['modelNames'], ['deckNames'], ...searches]);
      if (!models.includes(MODEL)) return { ok: false, reason: 'model', error: NO_MODEL };
      if (!decks.includes(a.deck)) return { ok: false, reason: 'deck', error: noDeck(a.deck) };
      return { ok: true, ids: lists.map((l) => (Array.isArray(l) && l.length ? l[0] : null)) };
    } catch (e) {
      return failure(e, a.deck);
    }
  }

  // Two marks clicked within a second are two crops in flight: the file and
  // the media name both carry a counter, or the second overwrites the first
  // on disk and AnkiConnect (deleteExisting by default) in the media folder.
  let pictureSeq = 0;

  /** The crop the watch process serves, as a file AnkiConnect can read. */
  async function pictureFor(region) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const tag = `${stamp}-${++pictureSeq}`;
    const file = path.join(os.tmpdir(), `yomi-anki-${process.pid}-${tag}.png`);
    const ok = await requestCrop(region, file, CROP_WAIT_MS);
    return ok ? { path: file, filename: `yomi-overlay-${tag}.png` } : null;
  }

  /** Add one Lapis note. Resolves to what happened; never rejects. */
  async function add(note) {
    const refused = gate();
    if (refused) return refusal(refused);
    const a = cfg.anki();
    const fields = lapisFields(note);
    const wantPicture = a.picture && note.region && requestCrop;
    const picture = wantPicture ? await pictureFor(note.region) : null;
    const body = {
      deckName: a.deck, modelName: MODEL, fields, tags: a.tags,
      // Per deck: the same word in another deck is a different course of
      // study. A duplicate here is answered with the note that already exists.
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    };
    if (picture) {
      body.picture = [{ path: picture.path, filename: picture.filename, fields: ['Picture'] }];
    }
    try {
      const noteId = await invoke('addNote', { note: body }, ADD_TIMEOUT_MS);
      logf(`[anki] added ${fields.Expression} → ${a.deck} (note ${noteId}`
           + `${picture ? ', with picture' : ''})`);
      return { ok: true, noteId };
    } catch (e) {
      if (/duplicate/.test(e.message)) {
        const found = await find([fields.Expression]);
        if (found.ok && found.ids[0]) return { ok: true, noteId: found.ids[0], existed: true };
      }
      const why = failure(e, a.deck);
      logf(`[anki] add ${fields.Expression} failed: ${why.error}`);
      return why;
    } finally {
      // AnkiConnect copied it into the media folder while answering.
      if (picture) fs.unlink(picture.path, () => {});
    }
  }

  async function remove(noteId) {
    try {
      await invoke('deleteNotes', { notes: [noteId] });
      logf(`[anki] removed note ${noteId}`);
      return { ok: true };
    } catch (e) {
      logf(`[anki] remove ${noteId} failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** The three Lapis files at the pinned tag, each checked against its digest. */
  async function fetchLapis() {
    const out = {};
    for (const [name, digest] of Object.entries(lapisSource.sha256)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), SOURCE_TIMEOUT_MS);
      let body;
      try {
        const res = await fetch(lapisSource.base + name, {
          headers: { 'User-Agent': 'yomi-overlay' }, signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${name}`);
        body = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`GitHub did not answer for ${name}`);
        if (e.message.startsWith('GitHub')) throw e;
        throw new Error(`could not download Lapis: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
      // A file that changed under the tag is not the note type this client's
      // fields were checked against: refuse it rather than install it.
      if (crypto.createHash('sha256').update(body).digest('hex') !== digest) {
        throw new Error(`${name} is not the one Lapis ${lapisSource.tag} released`);
      }
      out[name] = body.toString('utf8');
    }
    return out;
  }

  /**
   * Put the Lapis note type in Anki: fields, template, and stylesheet — no
   * deck, no note. Resolves to what happened; never rejects. Asked for by a
   * button in Settings, so it is not gated on Anki being on.
   */
  async function installLapis() {
    try {
      if ((await invoke('modelNames')).includes(MODEL)) return { ok: true, existed: true };
      const src = await fetchLapis();
      await invoke('createModel', {
        modelName: MODEL, inOrderFields: LAPIS_FIELDS, css: src['styling.css'], isCloze: false,
        cardTemplates: [{ Name: 'Mining', Front: src['front.html'], Back: src['back.html'] }],
      }, ADD_TIMEOUT_MS);
      logf(`[anki] installed the ${MODEL} note type (${lapisSource.tag})`);
      return { ok: true };
    } catch (e) {
      logf(`[anki] installing ${MODEL} failed: ${e.message}`);
      return failure(e);
    }
  }

  return { status, find, add, remove, installLapis };
}

module.exports = {
  createAnki, lapisFields, furiganaPlain, harmonicRank, searchValue, MODEL, NO_FREQUENCY,
  LAPIS_FIELDS, LAPIS_SOURCE,
};
