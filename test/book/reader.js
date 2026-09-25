// Runs inside a book chapter's page (injected as a string): the chapter as
// lines, a page of them shown with everything else masked, and the page's
// ground truth — every visible character's own rect, in reading order.
//
// A "line" is a column in vertical text and a row in horizontal text. Pages
// are whole lines: a line cut by the page edge would be half-read by any OCR
// and would score as an error in the reader, not in the recogniser.

module.exports = String.raw`(() => {
  const mode = getComputedStyle(document.documentElement).writingMode;
  const vertical = mode.startsWith('vertical');
  const JP = /[々぀-ヿ㐀-鿿０-ｚ０-９]/;

  /** Every non-space character: {c, rect, ruby, node order}. */
  function chars() {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const el = n.parentElement;
      if (!el || el.closest('rp, script, style')) continue;
      const ruby = !!el.closest('rt');
      const t = n.textContent;
      for (let i = 0; i < t.length; i++) {
        let len = 1;
        const code = t.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) len = 2;      // a surrogate pair
        const c = t.slice(i, i + len);
        if (len === 2) i++;
        if (/\s/.test(c)) continue;
        const r = document.createRange();
        r.setStart(n, i + 1 - len); r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        out.push({ c, ruby, x: b.left, y: b.top, w: b.width, h: b.height });
      }
    }
    return out;
  }

  // Block-axis extent of a rect: x for columns, y for rows.
  const lo = (b) => (vertical ? b.x : b.y);
  const hi = (b) => (vertical ? b.x + b.w : b.y + b.h);

  /** The chapter's lines in reading order, as block-axis extents. */
  function lines() {
    const base = chars().filter((c) => !c.ruby);
    const spans = base.map((b) => ({ a: lo(b), b: hi(b) }))
      .sort((p, q) => (vertical ? q.b - p.b : p.a - q.a));
    const out = [];
    for (const s of spans) {
      const last = out[out.length - 1];
      // Overlapping on the block axis is the same line (a tate-chu-yoko pair
      // sits side by side inside one column's cell).
      if (last && s.b > last.a + 1 && s.a < last.b - 1) {
        last.a = Math.min(last.a, s.a); last.b = Math.max(last.b, s.b);
      } else out.push({ ...s });
    }
    return out;
  }

  let masks = null;
  /** Shift the chapter so [a, b] (block axis) sits at \`at\`, and mask the rest. */
  function show(a, b, at, pad) {
    const shift = vertical ? at - b : at - a;
    document.body.style.transform = vertical ? 'translateX(' + shift + 'px)'
                                             : 'translateY(' + shift + 'px)';
    if (!masks) {
      masks = [0, 1].map(() => {
        const m = document.createElement('div');
        document.documentElement.appendChild(m);
        return m;
      });
    }
    const from = a + shift - pad.before, to = b + shift + pad.after;
    const base = 'position:fixed;background:#fff;z-index:2147483647;';
    if (vertical) {
      masks[0].style.cssText = base + 'top:0;bottom:0;left:0;width:' + Math.max(0, from)
        + 'px;';
      masks[1].style.cssText = base + 'top:0;bottom:0;right:0;left:' + to + 'px;';
    } else {
      masks[0].style.cssText = base + 'left:0;right:0;top:0;height:' + Math.max(0, from)
        + 'px;';
      masks[1].style.cssText = base + 'left:0;right:0;bottom:0;top:' + to + 'px;';
    }
    return { from, to };
  }

  /** What is on the page now: characters inside [from, to], grouped by line. */
  function truth(from, to, extents, shift) {
    const inPage = (c) => {
      const mid = vertical ? c.x + c.w / 2 : c.y + c.h / 2;
      return mid >= from && mid <= to && c.y >= 0 && c.x >= 0 &&
             c.y + c.h <= innerHeight && c.x + c.w <= innerWidth;
    };
    const all = chars().filter(inPage);
    const out = extents.map(() => ({ chars: [], ruby: [] }));
    for (const c of all) {
      const mid = (vertical ? c.x + c.w / 2 : c.y + c.h / 2) - shift;
      // A reading beside a column belongs with that column.
      let li = extents.findIndex((e) => mid >= e.a - 1 && mid <= e.b + 1);
      if (li < 0 && c.ruby) {
        li = extents.reduce((best, e, i) => {
          const d = Math.min(Math.abs(mid - e.a), Math.abs(mid - e.b));
          return best.d <= d ? best : { i, d };
        }, { i: -1, d: Infinity }).i;
      }
      if (li < 0) continue;
      (c.ruby ? out[li].ruby : out[li].chars).push(c);
    }
    return out.filter((l) => l.chars.length).map((l) => ({
      text: l.chars.map((c) => c.c).join(''), chars: l.chars, ruby: l.ruby,
      jp: JP.test(l.chars.map((c) => c.c).join('')) }));
  }

  window.__book = { vertical, lines, show, truth };
  return vertical;
})()`;
