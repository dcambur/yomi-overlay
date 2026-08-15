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
  // Matched as a PREFIX of the label, because an imported archive is called
  // whatever it calls itself: "三省堂国語辞典　第八版", not "三省堂". Keying on
  // the exact string sent every monolingual through the script heuristic
  // below, and put a grammar dictionary in with them.
  const DICT_KIND = [
    ['Jitendex', 'bi'], ['JMdict', 'bi'], ['Names', 'name'], ['JMnedict', 'name'],
    ['KANJIDIC', 'kanji'],
    ['三省堂', 'mono'], ['明鏡', 'mono'], ['旺文社', 'mono'], ['実用', 'mono'],
    ['DOJG', 'gram'], ['どんなとき', 'gram'], ['日本語文法辞典', 'gram'],
  ];
  // The order entries are shown in, whatever order the index returned them:
  // what the word means first, in the language that answers fastest; then the
  // Japanese definition; then how it is used; then reference material.
  const KIND_ORDER = { bi: 0, mono: 1, gram: 2, kanji: 3, name: 4 };

  // Unknown (user-added) dictionaries: guess from the glosses' script.
  function dictKind(en) {
    const hit = DICT_KIND.find(([name]) => String(en.dict).startsWith(name));
    if (hit) return hit[1];
    const sample = (en.glosses || []).join('');
    return /[぀-ヿ一-鿿]/.test(sample) ? 'mono' : 'bi';
  }

  /**
   * Entries in reading order, then kind order, with repeats removed.
   *
   * A word with several readings is answered by the same dictionary once per
   * reading, and two readings often share an entry — 大丈夫 came back with the
   * identical Jitendex block twice. Identity is the dictionary plus the
   * glossary itself; two entries that would print the same thing are one.
   */
  function orderEntries(entries) {
    const seen = new Set();
    const out = [];
    for (const en of entries) {
      const key = en.dict + '\u0000' + JSON.stringify(en.glosses);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(en);
    }
    // Stable: within a kind the index's own priority order survives, which is
    // what the arrows in settings control.
    return out
      .map((en, i) => ({ en, i, k: KIND_ORDER[dictKind(en)] ?? 9 }))
      .sort((a, b) => a.k - b.k || a.i - b.i)
      .map((x) => x.en);
  }

  // A line that opens with a sense marker: circled or parenthesised digits,
  // the kanji numerals a monolingual numbers its divisions with, or a bracket.
  const NUMBERED = /^\s*[\u2460-\u2473\u2776-\u277f\u3251-\u325f\u32b1-\u32bf\u3220-\u3229\u2460-\u24ff\uff10-\uff19\d][\s.、)）]?/;

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

  // A glossary is now whatever its dictionary wrote: a plain string for the
  // ones that ship text (明鏡, 旺文社, 実用, DOJG, どんなとき) or structured
  // content for the rest. Strings keep the formatting this popup already had;
  // structure is built as DOM by structured.js, which cannot be expressed as a
  // string here — so it is stubbed in and filled after innerHTML lands.
  let scSlots = [];

  function glossItem(g, dict) {
    if (typeof g === 'string') return glossHtml(g);
    return `<span data-sc="${scSlots.push({ g, dict }) - 1}"></span>`;
  }

  /** Replace the stubs with real nodes. Must run after innerHTML is assigned. */
  function fillStructured(root) {
    if (!window.structured) return;
    for (const slot of root.querySelectorAll('[data-sc]')) {
      const i = Number(slot.dataset.sc);
      const item = scSlots[i];
      if (!item) continue;
      slot.appendChild(window.structured.render(document, item.g, item.dict));
    }
    scSlots = [];
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /**
   * How the word on the page reaches the word in the dictionary.
   *
   * 始まりました → 始まる, and the steps that got there. The transformer knows
   * this and it used to be counted and discarded; it is the one thing a
   * learner is actually trying to work out when a form is unfamiliar.
   */
  function routeHtml(g) {
    if (!g.base || g.base === g.surface) return '';
    const steps = (g.route || []).map((s) => esc(s)).join('\u00b7');
    return `<div class="route">${esc(g.surface)}<span class="arr">\u2192</span>`
      + `<span class="ja">${esc(g.base)}</span>`
      + (steps ? `<span class="steps">\u2039${steps}\u203a</span>` : '')
      + '</div>';
  }

  /** Headword block: the dictionary form, its reading and pitch, how common. */
  function headerHtml(g) {
    const parts = ['<div class="hd">'];
    // The DICTIONARY form leads. A reader looking at 始まります wants 始まる —
    // that is the word to learn and to look up again; the form on the page is
    // a fact about this sentence, and it goes on the line below.
    parts.push(`<div class="term ja">${esc(g.base || g.surface)}</div>`);

    // A kanji answered by the single-character fallback has readings, not a
    // reading: 音 and 訓 belong in the body with their labels, and putting
    // them in the pitch slot implied an accent that does not exist for an
    // isolated character.
    const onlyKanji = g.entries.length > 0 && g.entries.every((e) => dictKind(e) === 'kanji');
    const rd = onlyKanji ? null : g.entries[0]?.reading;
    // Only accents FOR THE READING SHOWN. 下 came back with the accents of
    // した, しも, もと and げ, all hanging off げ.
    const acc = (g.pitch || []).filter((x) => !rd || x.reading === rd);
    if (acc.length && acc[0].reading) parts.push(pitchHtml(acc[0].reading, acc[0].position));
    else if (rd) parts.push(`<span class="pitch ja">${esc(rd)}</span>`);
    if (acc.length > 1) {
      parts.push(`<span class="pitch-num">${
        acc.slice(1, 4).map((x) => '[' + x.position + ']').join(' ')}</span>`);
    }

    // How common, right-aligned on the same line: it answers one yes/no
    // question and does not deserve a row of its own.
    const freq = (g.freq || []).slice(0, 2)
      .map((f) => `<span class="chip freq">${esc(f.source)} ${esc(String(f.value))}</span>`)
      .join('');
    if (freq) parts.push(`<span class="chips">${freq}</span>`);
    parts.push('</div>');
    parts.push(routeHtml(g));
    return parts.join('');
  }

  /** Every name reading this word has, as one dim line at the foot of a card. */
  function namesHtml(entries) {
    const readings = [];
    for (const en of entries) {
      for (const g of en.glosses) {
        const t = typeof g === 'string' ? g : (window.structured?.textOf(g) || '');
        for (const part of t.split(/[、,]/)) {
          const w = part.trim();
          if (w && !readings.includes(w)) readings.push(w);
        }
      }
    }
    if (!readings.length) return '';
    return `<div class="names ja"><span class="names-label">名</span>${
      esc(readings.slice(0, 24).join('、'))}</div>`;
  }

  function entryHtml(en, headerReading) {
    const kind = dictKind(en);
    const parts = [`<div class="ent ${kind}">`, '<div class="ent-hd">'];
    parts.push(`<span class="src ${kind}">${esc(en.dict)}</span>`);
    if (en.reading && en.reading !== headerReading && kind !== 'kanji') {
      parts.push(`<span class="rd ja">${esc(en.reading)}</span>`);
    }
    parts.push('</div>');

    if (kind === 'kanji') {
      if (en.on)  parts.push(`<div class="kv ja"><b>音</b>${esc(en.on)}</div>`);
      if (en.kun) parts.push(`<div class="kv ja"><b>訓</b>${esc(en.kun)}</div>`);
      parts.push(`<div>${en.glosses.map(g => glossItem(g, en.dict)).join(', ')}</div>`);
    } else if (kind === 'name') {
      const items = en.glosses.map((g) => glossItem(g, en.dict)).join('、 ');
      parts.push(`<div class="ja">${items}</div>`);
    } else if (kind === 'bi') {
      // A structured gloss carries its own senses and its own numbering, so
      // the list around it must not add a second marker — that was the stray
      // bullet sitting beside the part-of-speech tags.
      const structured = en.glosses.some((g) => typeof g !== 'string');
      parts.push(`<ul class="gl${structured ? ' sc' : ''}">`);
      for (const g of en.glosses) parts.push(`<li>${glossItem(g, en.dict)}</li>`);
      parts.push('</ul>');
    } else {   // mono, gram — lines carry their own numbering
      parts.push('<ul class="gl plain">');
      for (const g of en.glosses) {
        // The hanging indent belongs to a line that opens with a sense marker
        // and to no other: applied to unmarked prose it pushed every wrapped
        // line in and pulled the first one out, so a continuation and a new
        // sense started at the same place.
        const numbered = typeof g === 'string' && NUMBERED.test(g) ? ' numbered' : '';
        parts.push(`<li class="ja${numbered}">${glossItem(g, en.dict)}</li>`);
      }
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

      const entries = orderEntries(g.entries);
      // Proper names are a reference list, not a definition: 神 answers with
      // four blocks of kana readings before any dictionary says what it means.
      // One line, at the foot.
      const names = entries.filter((en) => dictKind(en) === 'name');
      const rest = entries.filter((en) => dictKind(en) !== 'name');

      // Inside a card the READING is the divider, not the dictionary: 神 is
      // かみ and しん and じん, and every dictionary answers for each. Grouping
      // by dictionary made the reader reassemble that themselves.
      const byReading = new Map();
      for (const en of rest) {
        const k = en.reading || '';
        if (!byReading.has(k)) byReading.set(k, []);
        byReading.get(k).push(en);
      }
      for (const [reading, list] of byReading) {
        if (byReading.size > 1 && reading) {
          parts.push(`<div class="rgroup ja">${esc(reading)}</div>`);
        }
        for (const en of list) parts.push(entryHtml(en, reading));
      }
      if (names.length) parts.push(namesHtml(names));
      parts.push('</div>');
    }
    popup.innerHTML = parts.join('');
    fillStructured(popup);
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
