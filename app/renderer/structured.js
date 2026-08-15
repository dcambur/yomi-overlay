// Yomitan structured content -> DOM.
//
// The index stores each glossary exactly as its dictionary wrote it, so this is
// where a dictionary finally becomes something to look at. Written against a
// census of what the twelve dictionaries here actually contain rather than
// against the format in the abstract:
//
//   node types   string, structured-content
//   tags         span div li ruby rt a img ul th td tr ol table br
//   style keys   verticalAlign marginRight fontSize fontWeight marginLeft
//                listStyleType fontStyle
//
// Yomitan's own generator is ~550 lines because it also carries their media
// pipeline, Anki rendering and language detection. Fourteen tags and seven
// properties do not need that, and its contentManager interface would have to
// be stubbed to something this app has no use for.
//
// UNKNOWN tags are not dropped. A dictionary nobody has seen is the entire
// reason the structure is kept, so anything unrecognised becomes a neutral
// inline or block element and its children are still rendered — the format
// degrades, the words survive.

(() => {
  // Only these properties are copied through. A glossary is data from a file
  // the user obtained elsewhere; letting it set arbitrary CSS on a panel that
  // floats over every window is not a privilege it needs.
  const STYLE = new Set([
    'verticalAlign', 'marginRight', 'marginLeft', 'fontSize', 'fontWeight',
    'listStyleType', 'fontStyle', 'textDecorationLine',
  ]);
  const BLOCK = new Set(['div', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'br']);
  const KNOWN = new Set([
    'span', 'div', 'li', 'ruby', 'rt', 'rp', 'a', 'img', 'ul', 'ol',
    'table', 'tr', 'td', 'th', 'br', 'em', 'strong', 'sup', 'sub',
  ]);

  // Dictionary media (the SVG markers monolinguals ship) is not extracted from
  // archives yet — see issue #11. Until it is, an <img> can only ever be a
  // broken one. Flipping this back on is the last step of that work.
  const MEDIA_AVAILABLE = false;

  /**
   * A marker's name from its filename, when the node carries no label.
   *
   * Only when the basename is SHORT and has no latin letters: 「㉑」 and 「一」
   * are markers a reader can use, "svg-accent/アクセント" and "stroke-order"
   * are filenames that would read as noise.
   */
  function fromPath(p) {
    if (typeof p !== 'string') return '';
    const base = p.split('/').pop()
      .replace(/\.[a-z0-9]+$/i, '')        // .svg
      .replace(/[-_][a-z0-9]+$/i, '');     // 一-fill, 一-bluefill, red_（
    if (!base || Array.from(base).length > 2 || /[a-z0-9_-]/i.test(base)) return '';
    return base;
  }

  /** Where an image lives once the importer has extracted it. */
  function mediaURL(dict, imgPath) {
    return `yomi-media://media/${encodeURIComponent(dict)}/`
      + String(imgPath).split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Every dictionary's own name for a thing -> one name the stylesheet knows.
   *
   * This is the difference between styling ONE dictionary and styling all of
   * them. Jitendex marks a sense `data.content = "sense"`; 三省堂 marks the
   * same thing `data.name = "語釈"`; 明鏡 uses `data.meikyo`. Written against
   * Jitendex's vocabulary alone, every rule in the stylesheet fired for
   * Jitendex and for nothing else — which is why the monolinguals rendered as
   * undifferentiated prose with their examples, cross-references and notes all
   * looking like definitions.
   *
   * The table is measured, not guessed: it is the node names those dictionaries
   * actually ship, counted. A name nobody here uses simply has no role, and
   * degrades to plain text as before.
   */
  const ROLES = {
    // Jitendex / JMdict (data.content, data.class)
    'sense': 'sense', 'glossary': 'glossary', 'sense-group': 'sense-group',
    'example-sentence': 'example', 'example-sentence-a': 'example-ja',
    'example-sentence-b': 'example-en', 'example-keyword': 'keyword',
    'part-of-speech-info': 'tag', 'misc-info': 'tag', 'tag': 'tag',
    'sense-note-label': 'note-label', 'sense-note-content': 'note',
    'xref': 'xref', 'reference-label': 'xref-label',
    'xref-content': 'xref', 'xref-glossary': 'xref',
    'attribution': 'meta', 'forms': 'meta', 'forms-label': 'meta',
    'graphic-attribution': 'meta', 'extra-info': 'extra', 'extra-box': 'extra',
    // 三省堂国語辞典 (data.name)
    '語釈': 'sense', '語義': 'sense-group', '語義番号': 'sense-num',
    '大語義': 'division', '用例': 'example', '用例G': 'example',
    '品詞': 'tag', '品詞G': 'tag', '品詞subG': 'tag', '語構成': 'tag',
    '表記': 'note', '表記G': 'note', '注記': 'note', '補説G': 'note',
    '参照': 'xref', '参照G': 'xref', '参照矢印': 'xref', '対義語G': 'xref',
    'アクセント': 'meta', '平板': 'meta', '分書': 'wordsep',
    'ルビG': 'furigana', 'ルビ': 'furigana',
    '見出部': 'headword', '見出仮名': 'headword', '見出相当部': 'headword',
    '最重要語': 'core', 'homophone': 'homophone',
    // 明鏡国語辞典 (data.meikyo)
    'furigana': 'furigana',
  };

  /** Roles a node claims through the image it stands in for, not by name. */
  const BY_SRC = [['最重要語', 'core'], ['重要語', 'core'], ['筆順', 'meta'],
                  ['アクセント', 'meta'], ['stroke', 'meta']];

  /** The role of a node, from whichever vocabulary its dictionary speaks. */
  function roleOf(data) {
    if (!data || typeof data !== 'object') return '';
    for (const v of [data.content, data.name, data.meikyo, data.class]) {
      if (typeof v === 'string' && ROLES[v]) return ROLES[v];
    }
    // 三省堂 names these nodes "img" and puts the meaning in the filename: the
    // core-vocabulary rank ＊＊ arrives as svg-logo/最重要語.svg, and rendered
    // by name alone it was two asterisks glued to the headword.
    const src = typeof data.src === 'string' ? data.src : '';
    if (src) {
      const hit = BY_SRC.find(([needle]) => src.includes(needle));
      if (hit) return hit[1];
    }
    return '';
  }

  /**
   * Carry the node's `data` object through as data-sc-* attributes.
   *
   * This is how the stylesheet can tell a glossary list from a sense list —
   * a dictionary's structure is all `ul` and `li`, and what each one MEANS is
   * only in `data`. Dropping it is why the popup rendered Jitendex as three
   * levels of browser-default bullets. Yomitan does the same thing.
   *
   * Values are set through `dataset`, never interpolated into markup, and the
   * key is reduced to letters and digits: this is dictionary-supplied text.
   */
  function applyData(el, data) {
    if (!data || typeof data !== 'object') return;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const key = String(k).replace(/[^a-zA-Z0-9]/g, '');
      if (!key) continue;
      el.dataset['sc' + key[0].toUpperCase() + key.slice(1)] = String(v);
    }
  }

  function applyStyle(el, style) {
    if (!style || typeof style !== 'object') return;
    for (const [k, v] of Object.entries(style)) {
      if (STYLE.has(k) && (typeof v === 'string' || typeof v === 'number')) {
        el.style[k] = typeof v === 'number' ? String(v) : v;
      }
    }
  }

  function image(doc, node, dict) {
    const label = node.title || node.alt;
    // Media is not extracted from archives yet (issue #11), so EVERY image is
    // one we cannot resolve — having a `path` does not mean having the file.
    // Emitting the <img> anyway put a broken-image box on every sense of every
    // monolingual: 三省堂 ships its sense markers (一, 二), its part-of-speech
    // marks and its accent glyphs as SVG, five to an entry.
    //
    // The label an image carries IS the marker — alt="一" is the sense number
    // — so it is shown as text. textOf() treats it as text for the same
    // reason. An image with no label is decoration we cannot draw, and a box
    // saying so is worth less than the space it takes.
    if (!MEDIA_AVAILABLE) {
      // The filename is the last resort, and a good one: a dictionary names
      // these after what they show — 一-fill.svg is the division marker 一,
      // ㉑.svg is sense 21. Without it, 明鏡 lost every sense number past ⓴ and
      // 三省堂 lost all six of its 大語義 dividers, leaving bare gaps.
      const named = label || fromPath(node.path);
      // An image with no name at all is decoration we cannot draw. Returning
      // an empty element for it put 348 of them in one page.
      if (!named) return doc.createDocumentFragment();
      const span = doc.createElement('span');
      span.className = 'sc-label';
      span.textContent = String(named);
      return span;
    }
    const el = doc.createElement('img');
    el.className = 'sc-img';
    if (node.path) el.src = mediaURL(dict, node.path);
    // Sizes are in em so an inline glyph scales with the surrounding text.
    const unit = node.sizeUnits === 'em' ? 'em' : 'px';
    if (typeof node.height === 'number') el.style.height = node.height + unit;
    if (typeof node.width === 'number') el.style.width = node.width + unit;
    // monochrome images are line art meant to take the text colour.
    if (node.appearance === 'monochrome') el.classList.add('sc-mono');
    if (label) el.alt = String(label);
    return el;
  }

  /**
   * One node (or list, or bare string) as DOM.
   * `dict` names the dictionary, so images can be resolved to its own media.
   */
  function render(doc, node, dict) {
    if (node === null || node === undefined) return doc.createTextNode('');
    // Runs of blank lines are collapsed: with the newlines kept (see the
    // stylesheet) and an image we cannot draw removed from between them, a
    // dropped stroke-order diagram left a hole the height of two lines.
    if (typeof node === 'string') {
      return doc.createTextNode(node.replace(/\n[ \t\n]*\n/g, '\n'));
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      return doc.createTextNode(String(node));
    }
    if (Array.isArray(node)) {
      const frag = doc.createDocumentFragment();
      for (const child of node) frag.appendChild(render(doc, child, dict));
      return frag;
    }

    // A whole glossary entry, or a nested one.
    if (node.type === 'structured-content') {
      return render(doc, node.content, dict);
    }
    if (node.type === 'text') return doc.createTextNode(String(node.text ?? ''));
    if (node.type === 'image' || node.tag === 'img') return image(doc, node, dict);

    const tag = typeof node.tag === 'string' ? node.tag.toLowerCase() : '';
    // 'a' becomes a span: a popup that floats over other applications has
    // nowhere to navigate to, and an external link is not something a
    // dictionary file should be able to put in front of someone.
    let name = tag === 'a' ? 'span' : tag;
    if (!KNOWN.has(name)) name = BLOCK.has(name) ? 'div' : 'span';
    const el = doc.createElement(name || 'span');
    if (tag && !KNOWN.has(tag)) el.dataset.tag = tag;
    applyData(el, node.data);
    // The one attribute the stylesheet reads. data-sc-* stays for debugging
    // and for anything dictionary-specific a future rule wants.
    const role = roleOf(node.data);
    if (role) el.dataset.role = role;
    if (role === 'core') {
      // The dictionary sizes this as a 0.6em superscript because it expects to
      // draw a logo there; what actually arrives is the text ＊＊, and an
      // inline style beats the stylesheet, so it rendered as stray asterisks
      // glued to the headword. Its own styling is dropped, not overridden —
      // there is nothing to override an inline style with.
      if (!el.title) el.title = 'core vocabulary';
    } else {
      applyStyle(el, node.style);
    }
    // A tag's own text ("noun (common) (futsuumeishi)") is worth keeping as a
    // tooltip; it is the only place the abbreviation is spelled out.
    if (typeof node.title === 'string' && node.title) el.title = node.title;
    if (node.content !== undefined) el.appendChild(render(doc, node.content, dict));
    return el;
  }

  /**
   * A whole glossary — the array stored for one entry — as one fragment.
   * Plain strings are the other shape dictionaries ship (明鏡, 旺文社, 実用,
   * DOJG and どんなとき give one newline-formatted string per entry), and they
   * become one block per line so the popup can lay them out.
   */
  function glossary(doc, glosses, dict) {
    const frag = doc.createDocumentFragment();
    for (const g of Array.isArray(glosses) ? glosses : [glosses]) {
      if (typeof g === 'string') {
        for (const line of g.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const div = doc.createElement('div');
          div.className = 'sc-line';
          div.textContent = t;
          frag.appendChild(div);
        }
      } else {
        const div = doc.createElement('div');
        div.className = 'sc-block';
        div.appendChild(render(doc, g, dict));
        frag.appendChild(div);
      }
    }
    return frag;
  }

  /** The text a reader would see. Ruby readings are excluded, exactly as the
   *  old index-time flattener excluded them — inlining 迷惑's ruby gives
   *  "迷 めい 惑 わく". */
  function textOf(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (node.tag === 'rt' || node.tag === 'rp') return '';
    if (node.type === 'text') return String(node.text ?? '');
    // An image that carries a label IS text to a reader: 三省堂 sets its sense
    // markers (ⓑ) and part-of-speech tags as SVG logos with the character in
    // `title`, so dropping them loses the numbering off the front of a sense.
    if (node.type === 'image' || node.tag === 'img') {
      return String(node.title || node.alt || '');
    }
    return textOf(node.content);
  }

  window.structured = { render, glossary, textOf, mediaURL };
})();
