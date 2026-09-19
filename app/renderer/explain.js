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

  // --- where a sentence may cross a line break ------------------------------
  //
  // Punctuation alone is not enough: a heading, a metadata row (★73,648 ・
  // 書籍化 ・ 2026年9月18日更新) or the next column has no 。 to stop at, and
  // the first real page (a syosetu ranking) sent the author, the tags, the
  // date and the NEXT title as one "sentence". So lines are first grouped
  // into blocks, and the walk never leaves the block the glyph is in. A block
  // boundary is any of:
  //   orientation   a yokogaki line beside a tategaki column
  //   column        the two lines share under 30% of the cross axis
  //   gap           the flow-axis gap is over 1.8× the page's median gap — a
  //                 paragraph, a heading, another bubble (page-a: 124–132px
  //                 at a paragraph or heading, 19–44px between the lines of
  //                 one; fixed thresholds fail across font sizes, the median
  //                 does not)
  //   not prose     under half of either line is kana/kanji — a stars-and-
  //                 dates row is its own block, never joined to a title
  // Deliberately NOT a rule: a line ending short of the block's edge. That
  // marks a paragraph end in justified prose but every line of a centred
  // manga bubble, which would split the bubble into one-line sentences.

  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f\u3005]/;
  const GAP_RATIO = 1.8;
  const OVERLAP_MIN = 0.3;

  /** A line's box, glyph size and orientation — what the block rules compare. */
  function shape(line, pageVertical) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const sizes = [];
    for (const c of line.chars || []) {
      x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
      sizes.push(c.h);
    }
    sizes.sort((a, b) => a - b);
    const vertical = line.vertical !== undefined ? !!line.vertical : !!pageVertical;
    return { x0, y0, x1, y1, size: sizes[sizes.length >> 1] || 0, vertical };
  }

  /** Flow-axis gap from `a` to the line after it: down the page, or leftward. */
  function gapBetween(a, b) {
    return a.vertical ? a.x0 - b.x1 : b.y0 - a.y1;
  }

  /** Share of the cross axis two lines have in common — 0 for another column. */
  function overlap(a, b) {
    const [a0, a1, b0, b1] = a.vertical ? [a.y0, a.y1, b.y0, b.y1] : [a.x0, a.x1, b.x0, b.x1];
    const span = Math.min(a1 - a0, b1 - b0);
    return span > 0 ? Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / span : 0;
  }

  function prose(line) {
    let cjk = 0, n = 0;
    for (const c of line.chars || []) {
      if (/\s/.test(c.c)) continue;
      n++;
      if (CJK.test(c.c)) cjk++;
    }
    return n > 0 && cjk / n >= 0.5;
  }

  /**
   * Block id per line index; ruby lines get none.
   *
   * A line continues the nearest EARLIER line in its own column, not the
   * line before it in the payload: Vision lists a two-column page top to
   * bottom, so the array interleaves the columns and the neighbour in it is
   * usually the other column's line.
   */
  function blocks(lines, pageVertical) {
    const ids = new Array(lines.length).fill(-1);
    const order = [];
    for (let li = 0; li < lines.length; li++) {
      if (lines[li] && !lines[li].ruby && (lines[li].chars || []).length) order.push(li);
    }
    const shapes = order.map((li) => shape(lines[li], pageVertical));
    const pred = order.map(() => -1);
    for (let i = 0; i < order.length; i++) {
      for (let j = i - 1; j >= 0; j--) {
        if (shapes[j].vertical === shapes[i].vertical &&
            overlap(shapes[j], shapes[i]) >= OVERLAP_MIN) { pred[i] = j; break; }
      }
    }
    const gaps = [];
    for (let i = 0; i < order.length; i++) {
      if (pred[i] >= 0) gaps.push(gapBetween(shapes[pred[i]], shapes[i]));
    }
    gaps.sort((p, q) => p - q);
    // Under three gaps there is no "typical" gap to compare against.
    const median = gaps.length >= 3 ? gaps[gaps.length >> 1] : 0;
    let next = 0;
    for (let i = 0; i < order.length; i++) {
      const j = pred[i];
      const split = j < 0 ||
        (median > 0 && gapBetween(shapes[j], shapes[i]) > GAP_RATIO * median) ||
        !prose(lines[order[j]]) || !prose(lines[order[i]]);
      ids[order[i]] = split ? next++ : ids[order[j]];
    }
    return ids;
  }

  /**
   * Every glyph on the page with its block, block by block: within a block the
   * lines keep their order, so a column reads straight through even when the
   * payload interleaves it with another. Ruby lines left out.
   */
  function flatten(lines, pageVertical) {
    const ids = blocks(lines, pageVertical);
    const out = [];
    const seen = new Set();
    for (const first of ids) {
      if (first < 0 || seen.has(first)) continue;
      seen.add(first);
      for (let li = 0; li < lines.length; li++) {
        if (ids[li] !== first) continue;
        const chars = lines[li].chars;
        for (let ci = 0; ci < chars.length; ci++) {
          out.push({ li, ci, c: chars[ci].c, b: first });
        }
      }
    }
    return out;
  }

  /**
   * The sentence containing glyph (li, ci): back to the previous terminator,
   * forward through the next one, across line breaks inside the block — a
   * line is where the page wrapped, not where the sentence ended. Both
   * yokogaki lines and tategaki columns arrive in reading order, so one walk
   * serves both.
   *
   * Returns the text, the glyph runs per line (for the highlight) and the
   * count, or null when the glyph is not on the page.
   */
  function sentenceAround(lines, li, ci, pageVertical) {
    const flat = flatten(lines, pageVertical);
    const at = flat.findIndex((g) => g.li === li && g.ci === ci);
    if (at < 0) return null;
    const b = flat[at].b;
    let start = at, end = at;
    while (start > 0 && flat[start - 1].b === b && !TERMINATORS.has(flat[start - 1].c)) start--;
    while (end < flat.length - 1 && flat[end + 1].b === b &&
           !TERMINATORS.has(flat[end].c)) end++;
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
    const sentence = sentenceAround(lines, li, ci, vertical);
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

  window.explain = { sentenceAround, blocks, show, openPicker, MAX_SENTENCE_GLYPHS };
})();
