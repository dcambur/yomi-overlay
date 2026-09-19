// Anki: the AnkiConnect client and the Lapis note it builds. docs/ANKI.md has
// the design and the measurements; this file is the contract.
//
// Main process only. AnkiConnect allows any request that carries no Origin
// header (plugin/web.py, allowOrigin), which is what a fetch from here sends,
// so there is no permission dialog and no CORS list to edit — and the
// renderer's CSP stays default-src 'none'.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { logf } = require('./log.js');

/** The note type, by name. The field names below are Lapis's own. */
const MODEL = 'Lapis';
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

/** AnkiConnect's error, in the words of the thing that is actually wrong. */
function explain(message, deck) {
  if (/model was not found/.test(message)) {
    return `the ${MODEL} note type is not in Anki — import Lapis.apkg first`;
  }
  if (/deck was not found/.test(message)) return `deck "${deck}" is not in Anki`;
  return message;
}

/**
 * The client. `cfg.anki()` is read per call, so a change in Settings applies
 * to the next request; `requestCrop(rect, file, waitMs)` is the watch
 * process's crop channel (tier2.js), and may be absent in a test.
 */
function createAnki({ cfg, requestCrop }) {
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
      throw new Error(code === 'ECONNREFUSED'
        ? `Anki is not running (nothing at ${a.url})` : `Anki: ${e.message}`);
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

  /** The note id each word already has in the chosen deck, or null. */
  async function find(expressions) {
    const refused = gate();
    if (refused) return { ok: false, error: refused };
    const a = cfg.anki();
    try {
      const lists = await multi(expressions.map((x) =>
        ['findNotes', { query: query(a.deck, x) }]));
      return { ok: true, ids: lists.map((l) => (Array.isArray(l) && l.length ? l[0] : null)) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** The crop the watch process serves, as a file AnkiConnect can read. */
  async function pictureFor(region) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const file = path.join(os.tmpdir(), `yomi-anki-${stamp}-${process.pid}.png`);
    const ok = await requestCrop(region, file, CROP_WAIT_MS);
    return ok ? { path: file, filename: `yomi-overlay-${stamp}.png` } : null;
  }

  /** Add one Lapis note. Resolves to what happened; never rejects. */
  async function add(note) {
    const refused = gate();
    if (refused) return { ok: false, error: refused };
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
      const why = explain(e.message, a.deck);
      logf(`[anki] add ${fields.Expression} failed: ${why}`);
      return { ok: false, error: why };
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

  return { status, find, add, remove };
}

module.exports = {
  createAnki, lapisFields, furiganaPlain, harmonicRank, searchValue, MODEL, NO_FREQUENCY,
};
