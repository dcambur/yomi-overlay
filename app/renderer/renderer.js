// The overlay renderer: glyph layer, hit-testing, and the popup's
// show/dismiss state machine.
//
// Moved out of index.html unchanged; see docs/REFACTOR.md. Splitting the
// pieces apart is the next commit.

const layer = document.getElementById('layer');
console.log('renderer script started');
const hud = document.getElementById('hud');

let lines = [];        // [{text, chars:[{c,x,y,w,h}]}]
let spans = [];        // parallel DOM spans, flat
let spanIndex = new Map();  // 'li:ci' -> span, avoids O(n) scans per hover
let current = null;    // currently highlighted span run
let lastKey = '';

function showHud(msg, ms = 2600) {
  hud.innerHTML = msg;
  hud.classList.add('show');
  clearTimeout(showHud._t);
  showHud._t = setTimeout(() => hud.classList.remove('show'), ms);
}

// --- build the invisible text layer ----------------------------------------
// Two rules keep the layer stable under the cursor:
//   1. Rebuild only when the recognised *text* changes. Glyph coordinates
//      jitter by a pixel between captures, so comparing whole payloads would
//      rebuild constantly and destroy the span you are pointing at.
//   2. Never rebuild while a popup is open — defer to when it closes, so a
//      page re-capture can't wipe what you are reading.
let pendingPayload = null;
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
// with each other — varying garbage never confirms itself.
let turnCandidate = null;   // line texts of the unconfirmed turn-like payload

function sharedRatio(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter(t => set.has(t)).length / Math.max(a.length, b.length);
}

window.overlay.onCapture(payload => {
  if (pinned) {
    // Minor jitter can wait until the popup closes. A confirmed page turn
    // cannot — if we kept deferring, the glyph layer would describe the
    // previous page and every later lookup would silently miss.
    if (isPageTurn(payload)) {
      const texts = (payload.lines || []).map(l => l.text);
      if (turnCandidate && sharedRatio(texts, turnCandidate) >= 0.5) {
        console.log('popup: page turn confirmed — dismissing');
        turnCandidate = null;
        pendingPayload = null;      // superseded by this payload
        dismiss();
        applyPayload(payload);
        return;
      }
      turnCandidate = texts;
      pendingPayload = payload;
      console.log('popup: turn-like payload parked, awaiting confirmation');
      return;
    }
    turnCandidate = null;
    pendingPayload = payload;
    return;
  }
  turnCandidate = null;
  applyPayload(payload);
});

// Target changed. Every span belongs to a window we no longer track, and the
// text-only signature must not be compared across two different apps — a stale
// signature can make the first real payload look ">85% similar" and be dropped.
window.overlay.onReset(() => {
  pendingPayload = null;
  dismiss();
  contentSig = '';
  frameSig = '';
  rejectedStreak = 0;
  layoutRef = new Map();
  lines = [];
  spans = [];
  spanIndex.clear();
  layer.innerHTML = '';
  targetOrigin = null;          // the old placement described the old target
  covers = [];                  // and so did the old cover rects
  layer.style.transform = '';
  hud.style.transform = '';
});

function isPageTurn(payload) {
  if (!contentSig) return true;
  const prev = new Set(contentSig.split('\u0001'));
  const now = (payload.lines || []).map(l => l.text);
  if (!now.length) return false;
  const shared = now.filter(t => prev.has(t)).length;
  return shared / Math.max(now.length, prev.size) < 0.5;
}

/**
 * Place the glyph layer at the target window's frame.
 *
 * The frame arrives in absolute screen coordinates; the layer's translation is
 * frame minus THIS window's actual on-screen position (window.screenX/Y).
 * Deliberately not main-process bookkeeping: macOS clamps, applies moves
 * asynchronously, and sometimes refuses a requested position outright, so any
 * offset computed from what was *asked for* drifts by exactly the discrepancy.
 * screenX/Y is what the window server actually did — the truth the glyphs
 * must be positioned against.
 */
let targetOrigin = null;   // {fx, fy} — target frame origin, screen coords

function applyPlacement() {
  if (!targetOrigin) return;
  const dx = targetOrigin.fx - window.screenX;
  const dy = targetOrigin.fy - window.screenY;
  // Diagnostic: the panel's own idea of where it is, which is the one input
  // that cannot be checked from the main process. On a fullscreen Space macOS
  // may composite the panel somewhere other than screenX/screenY reports.
  const sig = `${targetOrigin.fx},${targetOrigin.fy}|${window.screenX},${window.screenY}`;
  if (sig !== applyPlacement._last) {
    applyPlacement._last = sig;
    console.log(`place: target=${targetOrigin.fx},${targetOrigin.fy} ` +
                `panel.screenXY=${window.screenX},${window.screenY} ` +
                `inner=${window.innerWidth}x${window.innerHeight} -> dx,dy=${dx},${dy}`);
  }
  layer.style.transform = `translate(${dx}px, ${dy}px)`;
  // The HUD rides along so it appears over the target window, not in the
  // corner of the display.
  hud.style.transform = `translate(${dx}px, ${dy}px)`;
}

// Sent on every capture pass, not just the ones carrying new text: a page
// being read produces only heartbeats, and the target window can move while
// its content stays unchanged.
window.overlay.onOffset(o => { targetOrigin = o; applyPlacement(); });
// Self-heal: if macOS moves the panel under us between payloads, screenX/Y
// changes with no event we receive — recheck on a slow tick.
setInterval(applyPlacement, 1000);

// --- what is on top of the target -------------------------------------------
// Capture excludes every other window, so the payload looks identical whether
// the reader is in front or buried under the app the user just switched to.
// The glyph layer therefore stays alive over the new window, and a lookup
// there pops a dictionary entry for text nobody can see (measured: a popup for
// ほど over a Telegram window that fully covered the reader). The window server
// says what it is drawing in front; these are its rects, frame-local.
let covers = [];

/** A client point in the frame-local space the glyphs and covers use. */
function toFrame(x, y) {
  if (!targetOrigin) return null;
  return { x: x - (targetOrigin.fx - window.screenX),
           y: y - (targetOrigin.fy - window.screenY) };
}

function isCovered(p) {
  return !!p && covers.some(c => p.x >= c.x && p.x <= c.x + c.w &&
                                 p.y >= c.y && p.y <= c.y + c.h);
}

window.overlay.onCovers(list => {
  covers = Array.isArray(list) ? list : [];
  // A popup pinned to a word that has just been buried belongs to the window
  // underneath, not to the one now in front of it.
  if (!covers.length || !popupView.visible() || !current || !current.length) return;
  const r = current[0].getBoundingClientRect();
  if (isCovered(toFrame(r.left + r.width / 2, r.top + r.height / 2))) dismiss();
});

// The overlay is leaving the screen (target gone, or idle): the popup goes
// with it, so it cannot reappear pinned to a word that has since scrolled off.
window.overlay.onDismiss(() => dismiss());

let pageVertical = false;   // tategaki page: popup goes left of the column
let lastTier2Surface = '';  // last word sent to the tier-2 shadow probe

function applyPayload(payload) {
  if (payload.frame) {
    targetOrigin = { fx: payload.frame.x, fy: payload.frame.y };
    applyPlacement();
  }
  pageVertical = !!payload.vertical;

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
    return;                                // identical — keep the DOM
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
      return;
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
        return;
      }
      console.log(`layer: rebuild forced — 3 payloads rejected in a row ` +
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
  lastKey = '';        // indices just changed; stale key would block a lookup

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
  showHud(`${lines.length} lines · ${spans.length} glyphs — <b>Shift</b> + point`);
}

function clearHighlight() {
  if (!current) return;
  for (const el of current) el.classList.remove('hit');
  current = null;
}

// --- hover lookup -----------------------------------------------------------
// Shift is read off mousemove, not keydown: the window is focusable:false so it
// never receives key events, but every mouse event carries the modifier state.
//
// Sticky behaviour — once a lookup fires, the popup stays put after Shift is
// released so it can be read comfortably. It closes only when the cursor moves
// well clear of it, or when a new Shift-hover replaces it.
const DISMISS_PX = 90;
let pinned = false;
let lookupSeq = 0;              // discards out-of-order lookup replies
let interactiveState = false;   // mirrors main; avoids an IPC call per mousemove

// Trigger settings, replaced by main on load and whenever settings are saved.
let trigger = { modifier: 'shift', mode: 'hold', hoverDelayMs: 250 };
let hoverTimer = null;

const MODIFIER_PROP = {
  shift: 'shiftKey', control: 'ctrlKey', option: 'altKey', command: 'metaKey',
};
const MODIFIER_LABEL = {
  shift: 'Shift', control: 'Control', option: 'Option', command: 'Command',
};

/** Is the configured modifier held for this event? */
function modifierHeld(e) {
  return !!e[MODIFIER_PROP[trigger.modifier] || 'shiftKey'];
}

window.overlay.onTriggerConfig(t => {
  trigger = { ...trigger, ...t };
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  hud.innerHTML = trigger.mode === 'hover'
    ? 'overlay ready — hover to look up'
    : `overlay ready — <b>${MODIFIER_LABEL[trigger.modifier] || 'Shift'}</b> + point`;
});

function setInteractive(v) {
  if (v === interactiveState) return;
  interactiveState = v;
  window.overlay.setInteractive(v);
}

function dismiss() {
  popupView.hide();
  clearHighlight();
  lastKey = '';
  pinned = false;
  turnCandidate = null;
  setInteractive(false);
  if (pendingPayload) {           // page changed while the popup was open
    const p = pendingPayload;
    pendingPayload = null;
    applyPayload(p);
  }
}

function distanceOutside(r, x, y) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

// Global Shift-press / click, delivered from the native monitor with window
// coordinates. Fires a lookup at the cursor without requiring any movement.
window.overlay.onTrigger(ev => {
  lastKey = '';                      // an explicit trigger always re-queries
  doLookup(ev.x, ev.y);
});

document.addEventListener('mousemove', async e => {
  const visible = popupView.visible();

  if (visible) {
    const p = popupView.bounds();
    const inside = e.clientX >= p.left && e.clientX <= p.right &&
                   e.clientY >= p.top && e.clientY <= p.bottom;
    // Grab the mouse only while over the popup, so scrolling it works and
    // everything else still falls through to the target.
    setInteractive(inside);
    if (inside) return;
  }

  if (!modifierHeld(e)) {
    if (visible && pinned &&
        distanceOutside(popupView.bounds(), e.clientX, e.clientY) > DISMISS_PX) {
      dismiss();
    }
    // Hover mode: no key, look up once the cursor has settled on a glyph. The
    // dwell matters — firing on every mousemove would run a full lookup per
    // frame while the cursor is merely crossing the page.
    if (trigger.mode === 'hover') {
      if (hoverTimer) clearTimeout(hoverTimer);
      const { clientX: x, clientY: y } = e;
      hoverTimer = setTimeout(() => { hoverTimer = null; doLookup(x, y); },
                              trigger.hoverDelayMs);
    }
    return;
  }

  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  doLookup(e.clientX, e.clientY);
});

/**
 * The glyph span the cursor is actually aiming at.
 *
 * elementFromPoint returns the TOPMOST span, which under overlapping glyph
 * boxes is whichever came later in the DOM, not the glyph under the eye.
 * Per-glyph boxes are interpolated inside Vision's word-level boxes and can
 * come back fat (observed: a て span wide enough to cover the 信 beside it —
 * the highlight box spanned both chars — stealing lookups aimed at 信仰).
 * Among every glyph span under the point, the one whose center is nearest
 * the cursor wins: boxes are approximate, centers still rank correctly.
 */
function pickGlyph(px, py) {
  const hits = document.elementsFromPoint(px, py)
    .filter(e => e.classList.contains('g'));
  let best = null, bestD = Infinity;
  for (const e of hits) {
    const r = e.getBoundingClientRect();
    const d = Math.hypot(px - (r.left + r.width / 2),
                         py - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

async function doLookup(px, py) {
  // Another window is drawn over this part of the target: the spans are still
  // there (the capture never saw the covering window), but the text is not on
  // screen and the pixels under the cursor belong to somebody else.
  if (isCovered(toFrame(px, py))) return;
  // A payload parked while the popup was pinned means the layer is KNOWN
  // stale — hit-testing it looks up whatever glyph used to sit under the
  // cursor (measured: zoom in Kindle while a popup was open, then a lookup
  // on 生 matched the pre-zoom layer's が). Apply the parked payload first;
  // a rebuild at this instant is safe — the popup is about to re-render or
  // dismiss anyway, and spanIndex must describe the current pixels.
  if (pendingPayload) {
    const p = pendingPayload;
    pendingPayload = null;
    applyPayload(p);
  }
  const el = pickGlyph(px, py);
  if (!el) return;
  // Furigana are reading hints, not text — pointing at one must not look up
  // its kana (Phase 4).
  if (el.dataset.ruby) return;

  const li = +el.dataset.li, ci = +el.dataset.ci;
  const line = lines[li];
  if (!line) return;

  const key = li + ':' + ci;
  if (key === lastKey) return;
  lastKey = key;

  // Everything from the cursor to end of line is the lookup candidate. Sent as
  // one entry per span rather than a joined string, so the returned match
  // length is counted in glyphs and indexes the highlight run directly — a
  // UTF-16 offset cannot, once a non-BMP kanji is in the line.
  const tail = line.chars.slice(ci).map(c => c.c);
  const seq = ++lookupSeq;
  // line.hint carries the furigana printed beside this line — the page
  // itself names the reading, so entry ranking can prefer it (Phase 4).
  const res = await window.overlay.lookup(tail, line.hint || null);
  // A slow lookup must not overwrite a newer one the cursor has moved on to.
  if (seq !== lookupSeq) return;

  clearHighlight();
  if (!res) {
    popupView.hide();
    pinned = false;
    // lastKey deliberately kept. Clearing it re-ran this same failing query on
    // every mousemove within the glyph — roughly 60 full lookups a second, each
    // up to 12 prefixes × deinflections against synchronous SQLite in the main
    // process. A layer rebuild and an explicit Shift/click both reset it when a
    // re-query is genuinely wanted.
    setInteractive(false);   // never leave capture latched
    return;
  }

  // Highlight exactly the glyphs the match covers.
  const run = [];
  for (let k = 0; k < res.matchLength; k++) {
    const sp = spanIndex.get(li + ':' + (ci + k));
    if (sp) { sp.classList.add('hit'); run.push(sp); }
  }
  current = run;

  // Tier-2 shadow probe (Phase 3): ship the matched word's EXACT glyph-box
  // union — word-sized crops are the one granularity manga-ocr reads well
  // (whole lines make it hallucinate; measured). Once per surface, not per
  // hover jitter.
  if (res.surface !== lastTier2Surface) {
    lastTier2Surface = res.surface;
    const cs = ((lines[li] || {}).chars || []).slice(ci, ci + res.matchLength);
    if (cs.length) {
      const x0 = Math.min(...cs.map(c => c.x)), y0 = Math.min(...cs.map(c => c.y));
      const x1 = Math.max(...cs.map(c => c.x + c.w)), y1 = Math.max(...cs.map(c => c.y + c.h));
      const conf = Math.min(...cs.map(c => c.f !== undefined ? +c.f : 1));
      window.overlay.tier2({ x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4,
                             text: res.surface, conf });
    }
  }

  // Placement follows the orientation of the LINE actually hit, not the page
  // majority: a native vertical read carries the page's horizontal furniture
  // (headers, titles) in the same payload, and a popup for a horizontal title
  // must sit below the word, not beside a column that isn't there.
  const lineVertical = line.vertical !== undefined ? !!line.vertical : pageVertical;
  popupView.render(res, el.getBoundingClientRect(), lineVertical);
  pinned = true;
}

// Popup markup, pitch graphs, dictionary-kind styling, and placement all
// live in popup.js (window.popupView) — presentation only. This file owns
// WHEN a popup shows or dismisses; popup.js owns HOW it looks.
