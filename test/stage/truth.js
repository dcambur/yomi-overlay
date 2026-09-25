// Ground truth from the DOM: where a page's text really is.

const { check, note } = require('./harness.js');

// Single-line, directly texted, fully visible Japanese elements. Measured as
// TEXT, not element boxes: a padded block's rect can sit far from its glyphs.
const EXTRACT = `(() => {
  const re = /[\\u3040-\\u30ff\\u4e00-\\u9fff]{3,}/;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const t = Array.from(el.childNodes).filter(n => n.nodeType === 3)
      .map(n => n.textContent).join('').replace(/\\s+/g, '');
    if (!re.test(t)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (r.width < 20 || r.height < 10 || fs < 11) continue;
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
    if (r.height > fs * 1.9) continue;            // wrapped: no single anchor
    out.push({ text: t.slice(0, 24), x: Math.round(r.x), y: Math.round(r.y),
               h: Math.round(r.height) });
  }
  return out;
})()`;

// Every Japanese character's own rect: in vertical text a paragraph is one
// tall column, so only per-character truth locates anything.
const EXTRACT_CHARS = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode()) && out.length < 400) {
    const t = n.textContent;
    for (let i = 0; i < t.length; i++) {
      if (!/[\\u3040-\\u30ff\\u4e00-\\u9fff]/.test(t[i])) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 1);
      const b = r.getBoundingClientRect();
      if (b.width < 4 || b.height < 4) continue;
      out.push({ c: t[i], x: Math.round(b.x), y: Math.round(b.y),
                 w: Math.round(b.width), h: Math.round(b.height) });
    }
  }
  return out;
})()`;

const squash = (s) => s.replace(/\s+/g, '');

/**
 * How well recognised glyphs sit on the page's real text. `read` is lines of
 * glyph boxes relative to `at`; `probes` are DOM rects relative to `org`.
 * Asserted against the CLOSEST occurrence of each probe's text, so a
 * systematic shift still fails while a repeated nav label cannot fake one.
 */
function alignment(read, at, probes, org) {
  const needle = (p) => squash(p.text).slice(0, 6);
  // A probe whose text recurs cannot be pinned to one position.
  const unique = probes.filter((p) =>
    probes.filter((q) => squash(q.text).includes(needle(p))).length === 1);
  let matched = 0, aligned = 0, gross = 0, worst = '';
  for (const p of unique) {
    if (squash(p.text).length < 3) continue;
    let hit = null, best = Infinity;
    for (const ln of read) {
      // Indexed over the glyphs themselves: a line's text can carry spaces
      // (Vision puts them between the items of a nav bar) that no glyph has.
      const glyphs = ln.chars.filter((g) => g.c.trim());
      const i = glyphs.map((g) => g.c).join('').indexOf(needle(p));
      if (i < 0) continue;
      const c = glyphs[i];
      const d = Math.abs(at.x + c.x - (org.sx + p.x)) + Math.abs(at.y + c.y - (org.sy + p.y));
      if (d < best) { best = d; hit = c; }
    }
    if (!hit) continue;
    matched++;
    const dx = Math.round(at.x + hit.x - (org.sx + p.x));
    const dy = Math.round(at.y + hit.y - (org.sy + p.y));
    // The DOM rect's top is the line box; the glyph sits inside its leading.
    if (Math.abs(dx) <= 12 && Math.abs(dy) <= Math.max(10, p.h * 0.45)) aligned++;
    else if (Math.abs(dx) > 30 || Math.abs(dy) > 30) {
      gross++;
      worst = `'${p.text}' off by (${dx},${dy})`;
    }
  }
  return { probes: unique.length, matched, aligned, gross, worst };
}

function assertAligned(a, label) {
  note(`${label}: ${a.aligned}/${a.matched} probes on their glyphs, ${a.gross} gross`
       + (a.worst ? ` — worst ${a.worst}` : ''));
  check(a.matched >= 8, `only ${a.matched} of ${a.probes} probes were recognised at all`);
  check(a.aligned / a.matched >= 0.7, `${a.aligned}/${a.matched} aligned, need 70%`);
  check(a.gross === 0, `${a.gross} glyphs more than 30px off (${a.worst})`);
}
module.exports = { EXTRACT, EXTRACT_CHARS, squash, alignment, assertAligned };
