// The picker: model, thinking and effort for the next explanation, fanned out
// around the cursor like a pen picker, so a choice is one click from where the
// reader already is. Geometry and drawing only — what the choices ARE comes
// from main by way of explain.js, which also owns what a pick does.
//
// Three rings, inner to outer: model, thinking, effort. A half-disc opening
// upward from the cursor (downward when there is no room), so it never covers
// the line being read.
(() => {
  const host = document.getElementById('picker');
  const SVG = 'http://www.w3.org/2000/svg';
  // Inner and outer radius per ring. 30px bands: a 10.5px label sits inside a
  // band with room either side, and the outer ring's six wedges are 59px of
  // arc each — enough for "default" and "medium" without shrinking the type.
  const RINGS = [[30, 60], [64, 94], [98, 128]];
  const R = RINGS[RINGS.length - 1][1];
  const PAD = 6;

  let state = null;   // {rings, onPick, caption, flipped, cx, cy}

  function el(name, attrs) {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  /** A ring sector between angles a0..a1 (radians, clockwise from +x). */
  function wedgePath(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) =>
      `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}` +
           ` L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
  }

  function draw() {
    const { rings, caption, flipped } = state;
    const w = 2 * R + 2 * PAD, h = R + 2 * PAD + 16;
    const cx = R + PAD;
    const cy = flipped ? PAD : R + PAD;
    const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    rings.forEach((ring, ri) => {
      const [r0, r1] = RINGS[ri];
      const n = ring.options.length;
      ring.options.forEach((opt, i) => {
        // Upward: angles run π → 2π (left to right over the top). Downward:
        // 0 → π, so the first option stays on the left either way.
        const a0 = flipped ? Math.PI * i / n : Math.PI + Math.PI * i / n;
        const a1 = a0 + Math.PI / n;
        const path = el('path', { d: wedgePath(cx, cy, r0, r1, a0, a1), class: 'wedge' });
        path.dataset.ring = ring.key;
        path.dataset.index = i;
        if (opt.value === ring.current) path.classList.add('on');
        svg.appendChild(path);
        const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
        const label = el('text', { x: (cx + rm * Math.cos(am)).toFixed(1),
                                   y: (cy + rm * Math.sin(am)).toFixed(1) });
        label.textContent = opt.label;
        svg.appendChild(label);
      });
    });
    const cap = el('text', { x: cx, y: flipped ? R + PAD + 12 : h - 6, class: 'caption' });
    cap.textContent = caption;
    svg.appendChild(cap);
    host.replaceChildren(svg);
    host.style.left = (state.cx - cx) + 'px';
    host.style.top = (state.cy - cy) + 'px';
  }

  host.addEventListener('click', (e) => {
    const wedge = e.target.closest && e.target.closest('.wedge');
    if (!wedge || !state) return;
    const ring = state.rings.find((r) => r.key === wedge.dataset.ring);
    const opt = ring && ring.options[Number(wedge.dataset.index)];
    if (!opt) return;
    state.onPick(ring.key, opt.value);
  });

  /**
   * Open at (x, y) in window coordinates. `rings` is
   * [{key, current, options: [{value, label}]}], inner to outer.
   */
  function open({ x, y, rings, caption, onPick }) {
    // Room above the cursor is the normal case; a line at the top of the
    // window gets the fan below it instead of clipped.
    const flipped = y - R - PAD < 8;
    const cx = Math.min(Math.max(x, R + PAD + 8), window.innerWidth - R - PAD - 8);
    state = { rings, caption, onPick, flipped, cx, cy: y };
    draw();
    host.classList.add('show');
  }

  /** Redraw with new selections after a save came back from main. */
  function refresh(caption, config) {
    if (!state) return;
    for (const ring of state.rings) ring.current = config[ring.key];
    state.caption = caption;
    draw();
  }

  function close() {
    state = null;
    host.classList.remove('show');
    host.replaceChildren();
  }

  function bounds() { return host.getBoundingClientRect(); }
  function contains(x, y) {
    const b = bounds();
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  }

  window.picker = {
    open, close, refresh, bounds, contains,
    visible: () => host.classList.contains('show'),
  };
})();
