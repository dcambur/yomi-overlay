// What the sentence under the cursor means (the explain key). docs/EXPLAIN.md.
//
// WHEN a sentence is asked about is renderer.js's decision, like a lookup.
// This file owns the sentence itself — which glyphs make it — and the round
// trip: slice, cache, ask, draw. popup.js draws the frame, the vendored
// bot-answer element draws the answer, picker.js draws the choices.
(() => {
  const TERMINATORS = new Set(['。', '！', '？', '!', '?', '‼', '⁉']);
  // Claude's cost is per token and the popup's width is per glyph. On the
  // fixtures a manga bubble is ~20 glyphs and a novel sentence 40–70; 120
  // takes a long literary sentence whole and stops a page with no punctuation
  // (a title screen, a table) from sending everything it holds.
  const MAX_SENTENCE_GLYPHS = 120;
  // Pressing the key again on a sentence already explained must not spend
  // again — and a word click replaces the explanation with the dictionary, so
  // "again" is the common case, not the odd one.
  const CACHE_MAX = 32;
  const cache = new Map();

  let seq = 0;             // a newer press wins; an older reply is dropped
  let config = { skill: 'ja', model: null, thinking: null, effort: null,
                 models: [], efforts: [] };
  let anchor = null;       // {rect, vertical} of the explanation on screen

  /** Every glyph on the page in reading order, ruby lines left out. */
  function flatten(lines) {
    const out = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line || line.ruby) continue;
      const chars = line.chars || [];
      for (let ci = 0; ci < chars.length; ci++) out.push({ li, ci, c: chars[ci].c });
    }
    return out;
  }

  /**
   * The sentence containing glyph (li, ci): back to the previous terminator,
   * forward through the next one, across line breaks — a line is where the
   * page wrapped, not where the sentence ended. Both yokogaki lines and
   * tategaki columns arrive in reading order, so one walk serves both.
   *
   * Returns the text, the glyph runs per line (for the highlight) and the
   * count, or null when the glyph is not on the page.
   */
  function sentenceAround(lines, li, ci) {
    const flat = flatten(lines);
    const at = flat.findIndex((g) => g.li === li && g.ci === ci);
    if (at < 0) return null;
    let start = at, end = at;
    while (start > 0 && !TERMINATORS.has(flat[start - 1].c)) start--;
    while (end < flat.length - 1 && !TERMINATORS.has(flat[end].c)) end++;
    // Over the cap, keep the glyph the reader pointed at in the middle: the
    // start of a sentence is usually more useful than its end, but the
    // pointed-at word must stay in.
    if (end - start + 1 > MAX_SENTENCE_GLYPHS) {
      start = Math.max(start, at - (MAX_SENTENCE_GLYPHS >> 1));
      end = Math.min(end, start + MAX_SENTENCE_GLYPHS - 1);
    }
    const runs = [];
    for (let i = start; i <= end; i++) {
      const g = flat[i];
      const last = runs[runs.length - 1];
      if (last && last.li === g.li && last.ci + last.n === g.ci) last.n++;
      else runs.push({ li: g.li, ci: g.ci, n: 1 });
    }
    const text = flat.slice(start, end + 1).map((g) => g.c).join('');
    return { text, runs, glyphs: end - start + 1 };
  }

  // --- the round trip -------------------------------------------------------

  /** The skill, then only what overrides its defaults: "ja", "ja · opus · high". */
  function chipLabel() {
    const parts = [config.skill];
    if (config.model) parts.push(config.model);
    if (config.thinking !== null) parts.push(`thinking ${config.thinking ? 'on' : 'off'}`);
    if (config.effort) parts.push(config.effort);
    return parts.join(' · ');
  }

  function cacheKey(text) {
    return [text, config.model, config.thinking, config.effort].join('|');
  }

  function remember(key, result) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
  }

  /**
   * Explain the sentence around glyph span `el`. Returns whether a popup was
   * opened, so the caller can pin it the way it pins a lookup.
   */
  function show(el, vertical) {
    const { glyphLayer, popupView, hud } = window;
    const li = Number(el.dataset.li), ci = Number(el.dataset.ci);
    const lines = [];
    for (let i = 0; i < glyphLayer.lineCount; i++) lines.push(glyphLayer.lineAt(i));
    const sentence = sentenceAround(lines, li, ci);
    if (!sentence) return false;

    glyphLayer.clearHighlight();
    glyphLayer.highlightRuns(sentence.runs);
    const rect = el.getBoundingClientRect();
    anchor = { rect, vertical };
    const { view, chip } = popupView.renderExplain(sentence.text, rect, vertical, chipLabel());
    chip.onclick = () => {
      const r = chip.getBoundingClientRect();
      openPicker(r.left + r.width / 2, r.top);
    };

    const key = cacheKey(sentence.text);
    if (cache.has(key)) { view.result = cache.get(key); return true; }
    const mine = ++seq;
    hud.show(`explaining ${sentence.glyphs} glyphs…`);
    window.overlay.explain(sentence.text).then((res) => {
      if (mine !== seq) return;                        // superseded
      if (res && res.ok) remember(key, res);
      if (!view.isConnected) return;                   // popup already gone
      view.result = res || { ok: false, error: { code: 'claude_error', message: 'no answer' } };
    });
    return true;
  }

  // A word in the explanation, clicked: the ordinary lookup, drawn in the
  // same popup at the same anchor. The dictionary form is what the index
  // answers for; the surface is the fallback when the model gave none.
  document.addEventListener('lookup', async (e) => {
    const { popupView, hud } = window;
    const word = e.detail.base || e.detail.surface;
    if (!word || !anchor) return;
    const res = await window.overlay.lookup(Array.from(word), null);
    if (!res) { hud.show(`no entry for ${word}`); return; }
    popupView.render(res, anchor.rect, anchor.vertical);
  });

  // --- the picker -----------------------------------------------------------

  function openPicker(x, y) {
    const { picker } = window;
    const named = (label) => ({ value: label, label });
    picker.open({
      x, y,
      caption: chipLabel(),
      rings: [
        { key: 'model', current: config.model,
          options: [{ value: null, label: 'skill' }, ...config.models.map(named)] },
        { key: 'thinking', current: config.thinking,
          options: [{ value: null, label: 'skill' }, { value: true, label: 'on' },
                    { value: false, label: 'off' }] },
        { key: 'effort', current: config.effort,
          options: [{ value: null, label: 'default' }, ...config.efforts.map(named)] },
      ],
      // Saved through main, which pushes the merged settings back; the chip
      // and the picker redraw from that, so what is shown is what was saved.
      onPick: (key, value) => window.overlay.saveExplain({ [key]: value }),
    });
  }

  window.overlay.onExplainConfig((c) => {
    config = { ...config, ...c };
    const { popupView, picker } = window;
    if (popupView && popupView.visible()) popupView.setChip(chipLabel());
    if (picker && picker.visible()) picker.refresh(chipLabel(), config);
  });

  window.explain = { sentenceAround, show, openPicker, MAX_SENTENCE_GLYPHS };
})();
