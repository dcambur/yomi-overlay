// Where the glyph layer sits, and what is drawn on top of it.
//
// Two questions that look unrelated and are not: both are geometry between
// this panel and the target window, and both arrive on their own IPC channel
// because they change while the recognised text does not.
(() => {
  const layer = document.getElementById('layer');

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
  window.hud.element.style.transform = `translate(${dx}px, ${dy}px)`;
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

  window.placement = {
    toFrame,
    isCovered,
    apply: applyPlacement,
    setOrigin(o) { targetOrigin = o; applyPlacement(); },
    setCovers(list) { covers = Array.isArray(list) ? list : []; },
    get covers() { return covers; },
    /** The target changed: the old placement described the old window. */
    reset() {
      targetOrigin = null;
      covers = [];
      layer.style.transform = '';
      window.hud.element.style.transform = '';
    },
  };
})();
