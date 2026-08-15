// The invisible text layer: one span per recognised glyph, sitting exactly on
// top of the real one.
//
// One invariant justifies the file: **contentSig must always describe what is
// actually in the DOM.** Advancing it while keeping old spans is what let drift
// ratchet — ARCHITECTURE section 5.
//
// apply() returns which of four things happened:
//   'identical' matches the DOM · 'patched' voted correction written in place
//   'kept'      refused as jitter · 'rebuilt' torn down and rebuilt

(() => {
  const layer = document.getElementById('layer');

  let lines = [];        // [{text, chars:[{c,x,y,w,h}]}]
  let spans = [];        // parallel DOM spans, flat
  const spanIndex = new Map();  // 'li:ci' -> span, avoids O(n) scans per hover
  let current = null;    // currently highlighted span run

  // --- build the invisible text layer ----------------------------------------
  // Two rules keep the layer stable under the cursor:
  //   1. Rebuild only when the recognised *text* changes. Glyph coordinates
  //      jitter by a pixel between captures, so comparing whole payloads would
  //      rebuild constantly and destroy the span you are pointing at.
  //   2. Never rebuild while a popup is open — defer to when it closes, so a
  //      page re-capture can't wipe what you are reading.
  let contentSig = '';
  // Consecutive payloads the similarity gate refused. Vision jitter oscillates
  // between reads that periodically MATCH the DOM (resetting this); content
  // that keeps arriving and never matches is not jitter — see the gate below.
  let rejectedStreak = 0;
  // First-glyph position per line text, from the last build. Text alone cannot
  // tell "same page" from "same page, moved" — a resize or a scroll keeps every
  // line identical while every coordinate changes, and without this the spans
  // stay welded to where the glyphs used to be.
  let layoutRef = new Map();
  let frameSig = '';

  // Vision jitters glyph boxes by about a pixel between passes, so only a shift
  // larger than that counts as a real re-layout.

  const LAYOUT_EPSILON_PX = 3;

  function firstCharOf(line) {
    return line.chars && line.chars.length ? line.chars[0] : null;
  }

  /** Largest first-glyph displacement among lines present in both passes. */
  function layoutShift(incoming) {
    if (!layoutRef.size) return 0;
    let worst = 0;
    for (const line of incoming) {
      const prev = layoutRef.get(line.text);
      const c = firstCharOf(line);
      if (!prev || !c) continue;
      worst = Math.max(worst, Math.abs(c.x - prev.x), Math.abs(c.y - prev.y));
    }
    return worst;
  }

  // A payload can look like a page turn while being a transient bad read: an
  // animated image region re-recognises as different garbage each pass
  // (measured: 3→31→15 line swings on game targets, /tmp/yomi-overlay.log
  // 2026-08-09 20:13), and one such read shares <50% of lines with the DOM.
  // Dismissing on the first turn-like payload closed the popup mid-read with
  // no user action. A REAL page turn keeps producing the same new line set,
  // so dismissal requires two consecutive turn-like payloads that also agree

  function isPageTurn(payload) {
    if (!contentSig) return true;
    const prev = new Set(contentSig.split('\u0001'));
    const now = (payload.lines || []).map(l => l.text);
    if (!now.length) return false;
    const shared = now.filter(t => prev.has(t)).length;
    return shared / Math.max(now.length, prev.size) < 0.5;
  }

  function apply(payload) {
    const incoming = payload.lines || [];
    const fsig = payload.frame ? payload.frame.width + 'x' + payload.frame.height : '';

    // A resize, a scroll, or a reflowed column re-lays-out the *same* text. Both
    // short-circuits below compare text only, so without this the payload that
    // carries the corrected coordinates is thrown away, and every later lookup
    // hit-tests whatever glyph used to sit under the cursor.
    const moved = spans.length &&
    (fsig !== frameSig || layoutShift(incoming) > LAYOUT_EPSILON_PX);

    const sig = incoming.map(l => l.text).join('\u0001');
    if (!moved && sig === contentSig && spans.length) {
      rejectedStreak = 0;                    // content agrees with the DOM
      return 'identical';                    // nothing changed — keep the DOM
    }

    // Temporal-voting refinement (payload.vote >= 2): same page, same base
    // layout — the voted payload is built on the SAME first-pass layout the
    // spans came from, so li:ci indices line up. Correct characters in place;
    // a rebuild would yank spans out from under the cursor, and the 85% gate
    // below would otherwise silently drop a single-character correction.
    if (!moved && payload.vote >= 2 && spans.length && contentSig) {
    // Equal glyph counts, not just "every incoming char has a span": a voted
    // payload with FEWER chars would pass the per-char check below, leave the
    // surplus spans carrying stale text, and then claim the signature matches.
      const incomingN = incoming.reduce((n, l) => n + (l.chars || []).length, 0);
      let ok = incoming.length > 0 && incomingN === spans.length;
      for (let li = 0; li < incoming.length && ok; li++) {
        const chars = incoming[li].chars || [];
        for (let ci = 0; ci < chars.length; ci++) {
          const el = spanIndex.get(li + ':' + ci);
          if (!el) { ok = false; break; }   // structure mismatch — full path
          const c = chars[ci];
          if (el.textContent !== c.c) el.textContent = c.c;
          if (c.f !== undefined) el.dataset.f = c.f;
        }
      }
      if (ok) {
      // The DOM was just changed to match this payload; the signature — and
      // everything else that must keep describing the DOM — follows it.
      // `lines` feeds doLookup (a lookup after a voted correction must query
      // the corrected text, not the pass-1 read) and layoutRef is keyed by
      // line text, which the vote may have changed.
        contentSig = sig;
        lines = incoming;
        layoutRef = new Map();
        for (const line of incoming) {
          const c = firstCharOf(line);
          if (c) layoutRef.set(line.text, { x: c.x, y: c.y });
        }
        rejectedStreak = 0;
        return 'patched';
      }
    }

    // Vision is not deterministic: the same static page can recognise as 80 lines
    // one pass and 77 the next. A pure equality check would therefore rebuild
    // constantly and yank spans out from under the cursor. Treat a mostly-shared
    // line set as the same page; a real page turn replaces nearly every line.
    if (!moved && spans.length && contentSig) {
      const prev = new Set(contentSig.split('\u0001'));
      const now = sig.split('\u0001');
      const shared = now.filter(t => prev.has(t)).length;
      const similarity = now.length ? shared / Math.max(now.length, prev.size) : 0;
      // Keep the spans, but do NOT adopt the new signature. contentSig must keep
      // describing what is actually in the DOM: advancing it here lets drift
      // ratchet — a rotating carousel changes ~10% of lines per step, every step
      // stays >85% similar to the *previous* step, and the spans end up
      // describing content several rotations gone (hover 読む, look up 開始).
      // Compared against the built DOM, partial changes accumulate until they
      // cross the threshold and force an honest rebuild.
      //
      // Bounded, though. When a mostly-static line set dominates the count, the
      // changed part can NEVER cross the threshold: a game HUD holds 14 of 16
      // lines while the dialogue box changes, so every payload sits at ~88%
      // similar to the stale layer forever and lookups on the new text hit
      // nothing (measured: /tmp/yomi-overlay.log 2026-08-09 19:23, payloads
      // flowing with no rebuild until a manual capture restart). Jitter on a
      // static page periodically matches the DOM exactly and resets the streak
      // (the watcher only re-emits when recognised text changes); three misses
      // in a row means the page really is different — rebuild.
      if (similarity > 0.85) {
        rejectedStreak++;
        if (rejectedStreak < 3) {
          console.log(`layer: kept over payload ${(similarity * 100) | 0}% similar ` +
                    `(miss ${rejectedStreak}/3)`);
          return 'kept';
        }
        console.log('layer: rebuild forced — 3 payloads rejected in a row ' +
                  `(last ${(similarity * 100) | 0}% similar)`);
      }
    }
    rejectedStreak = 0;
    contentSig = sig;
    frameSig = fsig;

    lines = incoming;
    // innerHTML beats removing ~2,200 nodes one at a time.
    layer.innerHTML = '';
    spans = [];
    spanIndex.clear();
    clearHighlight();

    layoutRef = new Map();

    const frag = document.createDocumentFragment();   // one reflow, not thousands
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const anchor = firstCharOf(line);
      if (anchor) layoutRef.set(line.text, { x: anchor.x, y: anchor.y });
      for (let ci = 0; ci < line.chars.length; ci++) {
        const c = line.chars[ci];
        const el = document.createElement('span');
        el.className = 'g';
        el.textContent = c.c;
        el.style.left = c.x + 'px';
        el.style.top = c.y + 'px';
        el.style.width = c.w + 'px';
        el.style.height = c.h + 'px';
        el.style.fontSize = Math.max(8, c.h) + 'px';
        el.dataset.li = li;
        el.dataset.ci = ci;
        if (c.f !== undefined) el.dataset.f = c.f;   // voting confidence
        if (line.ruby) el.dataset.ruby = 1;          // furigana: not a lookup target
        frag.appendChild(el);
        spans.push(el);
        spanIndex.set(li + ':' + ci, el);
      }
    }
    layer.appendChild(frag);
    // The absolute screen position of the first glyph, measured through the DOM
    // (transform included). Comparable directly against the target window's
    // real content — this line is what end-to-end alignment tests assert on.
    if (spans.length) {
      const r = spans[0].getBoundingClientRect();
      console.log(`layer@ ${Math.round(window.screenX + r.left)},` +
                `${Math.round(window.screenY + r.top)} ` +
                `'${spans[0].textContent}' (${lines.length} lines, ${spans.length} glyphs)`);
    }
    return 'rebuilt';
  }

  function clearHighlight() {
    if (!current) return;
    for (const el of current) el.classList.remove('hit');
    current = null;
  }

  /** Mark the run of spans a match covers, and remember it. */
  function highlight(li, ci, n) {
    const run = [];
    for (let k = 0; k < n; k++) {
      const sp = spanIndex.get(li + ':' + (ci + k));
      if (sp) { sp.classList.add('hit'); run.push(sp); }
    }
    current = run;
    return run;
  }

  /** Target changed: every span belongs to a window we no longer track, and
   *  the text-only signature must not be compared across two different apps. */
  function reset() {
    clearHighlight();
    contentSig = '';
    frameSig = '';
    rejectedStreak = 0;
    layoutRef = new Map();
    lines = [];
    spans = [];
    spanIndex.clear();
    layer.innerHTML = '';
  }

  window.glyphLayer = {
    apply, isPageTurn, highlight, clearHighlight, reset,
    lineAt: (li) => lines[li],
    spanAt: (li, ci) => spanIndex.get(li + ':' + ci),
    get current() { return current; },
    get glyphCount() { return spans.length; },
    get lineCount() { return lines.length; },
  };
})();
