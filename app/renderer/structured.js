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

  /** Where an image lives once the importer has extracted it. */
  function mediaURL(dict, imgPath) {
    return `yomi-media://media/${encodeURIComponent(dict)}/`
      + String(imgPath).split('/').map(encodeURIComponent).join('/');
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
    const el = doc.createElement('img');
    el.className = 'sc-img';
    if (node.path) el.src = mediaURL(dict, node.path);
    // Sizes are in em so an inline glyph scales with the surrounding text.
    const unit = node.sizeUnits === 'em' ? 'em' : 'px';
    if (typeof node.height === 'number') el.style.height = node.height + unit;
    if (typeof node.width === 'number') el.style.width = node.width + unit;
    // monochrome images are line art meant to take the text colour.
    if (node.appearance === 'monochrome') el.classList.add('sc-mono');
    const label = node.title || node.alt;
    if (label) el.alt = String(label);
    return el;
  }

  /**
   * One node (or list, or bare string) as DOM.
   * `dict` names the dictionary, so images can be resolved to its own media.
   */
  function render(doc, node, dict) {
    if (node === null || node === undefined) return doc.createTextNode('');
    if (typeof node === 'string') return doc.createTextNode(node);
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
    applyStyle(el, node.style);
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
