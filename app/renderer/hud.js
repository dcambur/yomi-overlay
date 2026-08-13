// The transient status line. Rides the same transform as the glyph layer, so
// it appears over the target window rather than in a corner of the display.
(() => {
  const hud = document.getElementById('hud');

function showHud(msg, ms = 2600) {
  hud.innerHTML = msg;
  hud.classList.add('show');
  clearTimeout(showHud._t);
  showHud._t = setTimeout(() => hud.classList.remove('show'), ms);
}

  window.hud = {
    element: hud,
    show: showHud,
    /** Replace the resting text (what the HUD says when nothing is happening). */
    setText(html) { hud.innerHTML = html; },
  };
})();
