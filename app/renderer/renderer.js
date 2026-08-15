// What the renderer does WHEN, as opposed to how anything looks.
//
// The pieces it drives:
//   glyph-layer.js  the invisible span layer and its rebuild gate
//   placement.js    where that layer sits, and what covers it
//   popup.js        how a lookup result is drawn
//   hud.js          the transient status line
//
// This file owns the decisions between them: when a payload is applied, when
// a popup shows or dismisses, and what a pointer event means.

const { glyphLayer, placement, popupView, hud } = window;

console.log('renderer script started');

let pendingPayload = null;

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
    if (glyphLayer.isPageTurn(payload)) {
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

// Target changed. Every span belongs to a window we no longer track, and the
// old placement described the old target.
window.overlay.onReset(() => {
  pendingPayload = null;
  dismiss();
  glyphLayer.reset();
  placement.reset();
});

window.overlay.onCovers(list => {
  placement.setCovers(list);
  // A popup pinned to a word that has just been buried belongs to the window
  // underneath, not to the one now in front of it.
  const run = glyphLayer.current;
  if (!placement.covers.length || !popupView.visible() || !run || !run.length) return;
  const r = run[0].getBoundingClientRect();
  const mid = placement.toFrame(r.left + r.width / 2, r.top + r.height / 2);
  if (placement.isCovered(mid)) dismiss();
});

// The overlay is leaving the screen (target gone, or idle): the popup goes
// with it, so it cannot reappear pinned to a word that has since scrolled off.
window.overlay.onDismiss(() => dismiss());

let pageVertical = false;   // tategaki page: popup goes left of the column
let lastTier2Surface = '';  // last word sent to the tier-2 shadow probe

/**
 * Apply a payload: place the layer, then let it decide what to do with the
 * recognised text.
 */
function applyPayload(payload) {
  if (payload.frame) placement.setOrigin({ fx: payload.frame.x, fy: payload.frame.y });
  pageVertical = !!payload.vertical;
  const outcome = glyphLayer.apply(payload);
  if (outcome === 'rebuilt') {
    // Indices just changed; a stale key would block the next lookup.
    lastKey = '';
    hud.show(`${glyphLayer.lineCount} lines · ${glyphLayer.glyphCount} glyphs — ` +
             `<b>${MODIFIER_LABEL[trigger.modifier] || 'Shift'}</b> + point`);
  }
  return outcome;
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
// The word the popup is currently showing, so pointing along the same word does
// not re-query. It was never declared: every assignment created a property on
// window instead, which works in a classic script and would have thrown the
// moment this file was made strict or turned into a module.
let lastKey = '';
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
  hud.setText(trigger.mode === 'hover'
    ? 'overlay ready — hover to look up'
    : `overlay ready — <b>${MODIFIER_LABEL[trigger.modifier] || 'Shift'}</b> + point`);
});

function setInteractive(v) {
  if (v === interactiveState) return;
  interactiveState = v;
  window.overlay.setInteractive(v);
}

function dismiss() {
  popupView.hide();
  glyphLayer.clearHighlight();
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

document.addEventListener('mousemove', (e) => {
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
  if (placement.isCovered(placement.toFrame(px, py))) return;
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

  const li = Number(el.dataset.li), ci = Number(el.dataset.ci);
  const line = glyphLayer.lineAt(li);
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

  glyphLayer.clearHighlight();
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
  glyphLayer.highlight(li, ci, res.matchLength);

  // Tier-2 shadow probe (Phase 3): ship the matched word's EXACT glyph-box
  // union — word-sized crops are the one granularity manga-ocr reads well
  // (whole lines make it hallucinate; measured). Once per surface, not per
  // hover jitter.
  if (res.surface !== lastTier2Surface) {
    lastTier2Surface = res.surface;
    const cs = ((glyphLayer.lineAt(li) || {}).chars || []).slice(ci, ci + res.matchLength);
    if (cs.length) {
      const x0 = Math.min(...cs.map(c => c.x)), y0 = Math.min(...cs.map(c => c.y));
      const x1 = Math.max(...cs.map(c => c.x + c.w)), y1 = Math.max(...cs.map(c => c.y + c.h));
      const conf = Math.min(...cs.map(c => c.f !== undefined ? Number(c.f) : 1));
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

