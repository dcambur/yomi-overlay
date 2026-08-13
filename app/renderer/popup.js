// Popup presentation, split out of index.html — which keeps the glyph layer
// and the hit-testing/pin state machine. The boundary is deliberate: this
// file decides HOW a lookup result looks, index.html decides WHEN one shows.
// Pure presentation: no IPC, no layer state, no timers. index.html talks to
// it only through window.popupView.
//
// Renders the grouped result shape from lookup.js the way Yomitan lays out
// its popup: one headword section per matched prefix (longest first), every
// dictionary's definitions under it, scrolling instead of truncating.
(() => {
  const popup = document.getElementById('popup');

  // Dictionary kind drives how an entry renders — bilingual senses are a
  // bulleted list, monolingual senses keep their own ①❶ numbering, grammar
  // entries are prose-like, names are a single line. Mirrors how Yomitan
  // treats term / pitch / frequency / kanji dictionaries as different things.
  const DICT_KIND = {
    'Jitendex': 'bi', 'Names': 'name', 'KANJIDIC': 'kanji',
    '三省堂': 'mono', '明鏡': 'mono', '旺文社': 'mono', '実用': 'mono',
    'DOJG': 'gram', 'どんなとき': 'gram',
  };
  // Unknown (user-added) dictionaries: guess from the glosses' script.
  function dictKind(en) {
    if (DICT_KIND[en.dict]) return DICT_KIND[en.dict];
    const sample = (en.glosses || []).join('');
    return /[぀-ヿ一-鿿]/.test(sample) ? 'mono' : 'bi';
  }

  /** Split kana into morae: small ゃゅょ etc. bind to the preceding kana. */
  function morae(kana) {
    const small = 'ゃゅょぁぃぅぇぉャュョァィゥェォヮ';
    const out = [];
    for (const ch of kana) {
      if (small.includes(ch) && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  /**
   * Yomitan-style pitch graph: high morae carry an overline, the mora before a
   * downstep also a falling right edge.  position 0 = heiban (LHHH…, no fall),
   * 1 = atamadaka (HLLL…), n = drop after mora n.
   */
  function pitchHtml(reading, position) {
    const ms = morae(reading);
    const spans = ms.map((m, i) => {
      const hi = position === 0 ? i > 0
               : position === 1 ? i === 0
               : i > 0 && i < position;
      const fall = position > 0 && i === position - 1;
      return `<span class="m${hi ? ' hi' : ''}${fall ? ' fall' : ''}">${esc(m)}</span>`;
    });
    return `<span class="pitch ja">${spans.join('')}</span>` +
           `<span class="pitch-num">[${position}]</span>`;
  }

  /** Dim quoted usage examples (「━政治」) inside a monolingual sense line. */
  function glossHtml(g) {
    return esc(g).replace(/「[^」]*」/g, m => `<span class="ex">${m}</span>`);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** Headword block: term, reading/pitch row, base + frequency chips. */
  function headerHtml(g) {
    const parts = [];
    parts.push(`<div class="term ja">${esc(g.surface)}</div>`);

    const rd = g.entries[0]?.reading;
    const p = g.pitch?.length ? g.pitch[0] : null;
    if (rd || p) {
      parts.push('<div class="hdr-rd">');
      if (p && p.reading) parts.push(pitchHtml(p.reading, p.position));
      else if (rd) parts.push(`<span class="pitch ja">${esc(rd)}</span>`);
      // Further accent variants, numbers only.
      if (g.pitch?.length > 1) {
        parts.push(`<span class="pitch-num">${
          g.pitch.slice(1, 4).map(x => '[' + x.position + ']').join(' ')}</span>`);
      }
      parts.push('</div>');
    }

    const chips = [];
    if (g.base) chips.push(`<span class="chip base ja">← ${esc(g.base)}</span>`);
    for (const f of (g.freq || []).slice(0, 2)) {
      chips.push(`<span class="chip freq">${esc(f.source)} ${esc(String(f.value))}</span>`);
    }
    if (chips.length) parts.push(`<div class="chips">${chips.join('')}</div>`);
    return parts.join('');
  }

  function entryHtml(en, headerReading) {
    const kind = dictKind(en);
    const parts = ['<div class="ent">', '<div class="ent-hd">'];
    parts.push(`<span class="src ${kind}">${esc(en.dict)}</span>`);
    if (en.reading && en.reading !== headerReading && kind !== 'kanji') {
      parts.push(`<span class="rd ja">${esc(en.reading)}</span>`);
    }
    parts.push('</div>');

    if (kind === 'kanji') {
      if (en.on)  parts.push(`<div class="kv ja"><b>音</b>${esc(en.on)}</div>`);
      if (en.kun) parts.push(`<div class="kv ja"><b>訓</b>${esc(en.kun)}</div>`);
      parts.push(`<div>${en.glosses.map(esc).join(', ')}</div>`);
    } else if (kind === 'name') {
      parts.push(`<div class="ja">${en.glosses.map(esc).join('、 ')}</div>`);
    } else if (kind === 'bi') {
      parts.push('<ul class="gl">');
      for (const g of en.glosses) parts.push(`<li>${glossHtml(g)}</li>`);
      parts.push('</ul>');
    } else {   // mono, gram — lines carry their own numbering
      parts.push('<ul class="gl plain">');
      for (const g of en.glosses) parts.push(`<li class="ja">${glossHtml(g)}</li>`);
      parts.push('</ul>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  /**
   * Render a lookup result anchored to the hovered glyph's rect.
   * `anchorRect` is a DOMRect in viewport coordinates; `pageVertical` picks
   * the tategaki placement (left of the column, flipping right).
   */
  function render(res, anchorRect, pageVertical) {
    const groups = res.groups || [res];
    const parts = [];
    // One card per headword group, every group equal rank: separation comes
    // from the card surface, priority from ORDER alone — the first card is
    // the longest match, not a typographically privileged one.
    for (const g of groups) {
      parts.push('<div class="card">');
      parts.push(headerHtml(g));
      const rd = g.entries[0]?.reading;
      for (const en of g.entries) parts.push(entryHtml(en, rd));
      parts.push('</div>');
    }
    popup.innerHTML = parts.join('');
    popup.style.display = 'block';
    popup.scrollTop = 0;       // a fresh word must not inherit the old scroll

    const r = anchorRect;
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    let x, y;
    if (pageVertical) {
      // Tategaki reads down the column, then to the NEXT column on the left —
      // so left-of-column occludes what was already read, never what is being
      // read... except that the next column is also to the left. Prefer left;
      // flip right only when there is no room.
      x = r.left - pw - 10;
      y = r.top;
      if (x < 8) x = r.right + 10;
      if (y + ph > window.innerHeight - 8) y = window.innerHeight - ph - 8;
    } else {
      // Place below the word, flipping up / clamping in as needed.
      x = r.left; y = r.bottom + 7;
      if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
      if (y + ph > window.innerHeight - 8) y = r.top - ph - 7;
    }
    popup.style.left = Math.max(8, x) + 'px';
    popup.style.top = Math.max(8, y) + 'px';
  }

  window.popupView = {
    render,
    hide() { popup.style.display = 'none'; },
    visible() { return popup.style.display === 'block'; },
    bounds() { return popup.getBoundingClientRect(); },
  };
})();
