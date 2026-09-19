/* <bot-answer> — renders a bot-api component tree (contract v1) inside any DOM host.
 *
 * Zero dependencies. Loads as a classic <script> or as a side-effect ES module.
 * Nothing here is styled to a brand: every color and face is a CSS custom property
 * with a quiet fallback, so a host sets four variables and the panel looks native.
 *
 *   const el = document.createElement('bot-answer');
 *   el.loading = true;                      // skeleton while the model answers (2-6 s)
 *   el.data = result.structured;            // {component_version, component}
 *   el.error = 'message';                   // or an error line instead
 *   el.addEventListener('lookup', (e) => e.detail /* {surface, reading, base} *\/);
 *
 * Theme hooks (set on the element or any ancestor):
 *   --ba-fg --ba-muted --ba-accent --ba-rule --ba-font --ba-font-cjk --ba-size
 */
(() => {
  if (customElements.get('bot-answer')) return;

  const CSS = `
    :host {
      display: block;
      container-type: inline-size;
      color: var(--ba-fg, inherit);
      font: var(--ba-size, 14px)/1.5 var(--ba-font, -apple-system, system-ui, "Segoe UI", sans-serif);
      --_muted: var(--ba-muted, color-mix(in srgb, currentColor 58%, transparent));
      --_accent: var(--ba-accent, #c9a25a);
      --_rule: var(--ba-rule, color-mix(in srgb, currentColor 14%, transparent));
      --_cjk: var(--ba-font-cjk, "Hiragino Mincho ProN", "Noto Serif CJK JP", "Songti SC", "Noto Serif CJK SC", serif);
    }
    :host([hidden]) { display: none; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .root { animation: in .18s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(2px); } }
    @media (prefers-reduced-motion: reduce) { .root, .sk::after { animation: none; } }

    /* what it means, first; politeness/tense as a chip beside it, not a stray line */
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 1em; }
    .translation { font-weight: 500; letter-spacing: .005em; }
    .style { flex: none; font-size: .7em; color: var(--_muted); letter-spacing: .06em; text-transform: lowercase; white-space: nowrap; }

    /* the sentence, glossed word by word: the sentence line stays straight, glosses hang */
    .gloss-row {
      display: flex; flex-wrap: wrap; align-items: flex-start;
      gap: .35em .55em; margin-top: .8em; padding-top: .8em;
      border-top: 1px solid var(--_rule);
    }
    .seg {
      display: inline-flex; flex-direction: column; align-items: center;
      max-width: 100%; border-radius: 4px; cursor: default;
      padding: 0 .1em .15em; margin: 0 -.1em;
    }
    .seg[tabindex] { cursor: pointer; }
    .seg[tabindex]:hover .surface, .seg[tabindex]:focus-visible .surface { color: var(--_accent); }
    .seg:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
    .surface {
      font-family: var(--_cjk); font-size: 1.5em; line-height: 1.15;
      white-space: nowrap; transition: color .12s;
    }
    ruby { ruby-align: center; }
    rt { font-family: var(--ba-font, sans-serif); font-size: .5em; color: var(--_muted); letter-spacing: .02em; }
    .gloss {
      font-size: .74em; line-height: 1.25; color: var(--_muted);
      text-align: center; max-width: 9em; margin-top: .3em; overflow-wrap: anywhere;
    }
    /* the teacher's pen: particles and auxiliaries carry a hairline in the accent */
    .seg-particle .surface, .seg-aux .surface {
      text-decoration: underline; text-decoration-color: var(--_accent);
      text-decoration-thickness: 1.5px; text-underline-offset: .22em;
    }
    .seg-particle .gloss { color: var(--_accent); font-variant: all-small-caps; letter-spacing: .04em; max-width: 7em; }
    .seg-punct .surface { color: var(--_muted); }
    .seg-punct .gloss { visibility: hidden; }   /* keeps 。 on the sentence baseline */
    .seg-punct .gloss::before { content: "\\00a0"; }
    .seg-punct { cursor: default; }

    /* grammar: named pattern on the left, one line on the right */
    .grammar { list-style: none; margin-top: .8em; display: grid; grid-template-columns: fit-content(38%) 1fr; gap: .35em .9em; font-size: .93em; }
    .grammar li { display: contents; }
    .pattern { font-family: var(--_cjk); color: var(--_accent); }
    .nuance { margin-top: .8em; font-size: .93em; color: var(--_muted); font-style: italic; }
    @container (max-width: 400px) {
      .surface { font-size: 1.35em; }
      .gloss-row { gap: .3em .45em; }
      .grammar { grid-template-columns: 1fr; gap: .15em; }
      .grammar li + li .pattern { margin-top: .45em; }
      .head { flex-direction: column; gap: .2em; }
    }

    /* word card */
    .headword { display: flex; align-items: baseline; flex-wrap: wrap; gap: .5em; }
    .headword .surface { font-size: 1.7em; }
    .base { color: var(--_muted); font-size: .9em; }
    .tag { font-size: .7em; color: var(--_muted); border: 1px solid var(--_rule); border-radius: 3px; padding: .05em .4em; letter-spacing: .04em; }
    .meanings { margin: .6em 0 0 1.4em; }
    .meanings li { padding: .1em 0; }
    .meanings li::marker { color: var(--_accent); }
    .example { margin-top: .7em; display: flex; flex-direction: column; gap: .15em; }
    .example .ja { font-family: var(--_cjk); font-size: 1.1em; }
    .example .en { color: var(--_muted); font-size: .9em; }

    /* comparison */
    .title { font-weight: 500; }
    .compare { margin-top: .6em; border-collapse: collapse; width: 100%; font-size: .93em; }
    .compare th, .compare td { text-align: left; vertical-align: top; padding: .4em .6em .4em 0; border-top: 1px solid var(--_rule); }
    .compare thead th { border-top: 0; color: var(--_accent); font-weight: 500; font-family: var(--_cjk); }
    .compare tbody th { color: var(--_muted); font-weight: 400; white-space: nowrap; }

    /* steps */
    .steps { margin: .6em 0 0 1.5em; }
    .steps li { padding: .15em 0; }
    .steps li::marker { color: var(--_accent); font-family: var(--_cjk); }
    .steps .label { font-weight: 500; }

    /* text */
    .text p + p, .text ul + p, .text p + ul { margin-top: .6em; }
    .text ul { margin-left: 1.3em; }
    .text code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: var(--_rule); border-radius: 3px; padding: .05em .3em; }

    /* skeleton while the model is thinking; error when it is not */
    .sk { display: grid; gap: .55em; }
    .sk i { display: block; height: .9em; border-radius: 3px; background: var(--_rule); position: relative; overflow: hidden; }
    .sk .l1 { width: 72%; } .sk .l2 { width: 100%; height: 1.6em; margin-top: .5em; } .sk .l3 { width: 55%; }
    .sk i::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, color-mix(in srgb, currentColor 10%, transparent), transparent);
      animation: shimmer 1.3s infinite; }
    @keyframes shimmer { to { transform: translateX(100%); } }
    .error { color: var(--_muted); font-size: .93em; }
    .error b { color: var(--_accent); font-weight: 500; }
  `;

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ruby = (surface, reading, reserve = false) => (reading && reading !== surface)
    ? `<ruby>${esc(surface)}<rt>${esc(reading)}</rt></ruby>`
    : (reserve ? `<ruby>${esc(surface)}<rt>&nbsp;</rt></ruby>` : esc(surface));
  // `**bold**` and `` `code` `` are the only inline marks the contract allows.
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');

  const R = {
    explanation(c) {
      const segs = c.segments.map((s, i) => {
        const clickable = s.role !== 'punct';
        return `<span class="seg seg-${esc(s.role || 'word')}" data-i="${i}"${clickable ? ' tabindex="0" role="button"' : ''}>`
          + `<span class="surface">${ruby(s.surface, s.reading, true)}</span>`
          + `<span class="gloss">${esc(s.gloss)}</span></span>`;
      }).join('');
      const grammar = (c.grammar || []).map((g) =>
        `<li><span class="pattern">${esc(g.pattern)}</span><span>${esc(g.note)}</span></li>`).join('');
      return `<div class="head"><p class="translation">${esc(c.translation)}</p>`
        + (c.style ? `<span class="style">${esc(c.style)}</span>` : '') + `</div>`
        + `<div class="gloss-row">${segs}</div>`
        + (grammar ? `<ul class="grammar">${grammar}</ul>` : '')
        + (c.nuance ? `<p class="nuance">${esc(c.nuance)}</p>` : '');
    },
    word(c) {
      const pos = (c.pos || []).map((p) => `<span class="tag">${esc(p)}</span>`).join(' ');
      return `<p class="headword"><span class="surface">${ruby(c.headword, c.reading)}</span>`
        + (c.base ? `<span class="base">${esc(c.base)}</span>` : '') + pos + `</p>`
        + `<ol class="meanings">${c.meanings.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>`
        + (c.example ? `<p class="example"><span class="ja">${esc(c.example.text)}</span><span class="en">${esc(c.example.translation)}</span></p>` : '')
        + (c.note ? `<p class="nuance">${esc(c.note)}</p>` : '');
    },
    comparison(c) {
      const rows = c.rows.map((r) => `<tr><th>${esc(r.aspect)}</th><td>${esc(r.left)}</td><td>${esc(r.right)}</td></tr>`).join('');
      return `<p class="title">${esc(c.title)}</p>`
        + `<table class="compare"><thead><tr><th></th><th>${esc(c.left)}</th><th>${esc(c.right)}</th></tr></thead><tbody>${rows}</tbody></table>`
        + (c.summary ? `<p class="nuance">${esc(c.summary)}</p>` : '');
    },
    steps(c) {
      return (c.title ? `<p class="title">${esc(c.title)}</p>` : '')
        + `<ol class="steps">${c.steps.map((s) => `<li><span class="label">${esc(s.label)}</span> ${esc(s.detail)}</li>`).join('')}</ol>`;
    },
    text(c) {
      const out = [];
      let bullets = [];
      const flush = () => { if (bullets.length) { out.push(`<ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>`); bullets = []; } };
      for (const para of String(c.markdown || '').trim().split(/\n{2,}/)) {
        for (const line of para.split('\n')) {
          if (line.startsWith('- ')) bullets.push(inline(line.slice(2)));
          else { flush(); out.push(`<p>${inline(line)}</p>`); }
        }
        flush();
      }
      return `<div class="text">${out.join('')}</div>`;
    },
  };

  let _sheet = null;
  const sheet = () => {
    if (!_sheet) { _sheet = new CSSStyleSheet(); _sheet.replaceSync(CSS); }
    return _sheet;
  };

  class BotAnswer extends HTMLElement {
    static get observedAttributes() { return ['loading']; }

    constructor() {
      super();
      this._data = null;
      const root = this.attachShadow({ mode: 'open' });
      // A constructed stylesheet, not a <style> element: hosts with a strict CSP
      // (style-src 'self', no 'unsafe-inline' — yomi-overlay's renderer) block
      // inline styles even inside a shadow root, while CSSOM is not subject to CSP.
      if (root.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function') {
        root.adoptedStyleSheets = [sheet()];
        root.innerHTML = '<div class="root" part="root"></div>';
      } else {
        root.innerHTML = `<style>${CSS}</style><div class="root" part="root"></div>`;
      }
      this._root = root.querySelector('.root');
      this._root.addEventListener('click', (e) => this._hit(e));
      this._root.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._hit(e); } });
    }

    attributeChangedCallback() { this._render(); }
    connectedCallback() { this._render(); }

    /** The component tree: {component_version, component} — or the bare component. */
    get data() { return this._data; }
    set data(value) {
      this._data = value && value.component ? value : (value ? { component: value } : null);
      this._error = null;
      this.loading = false;
      this._render();
    }
    /** Show an error line instead of content. */
    set error(message) { this._error = message; this._data = null; this.loading = false; this._render(); }
    get loading() { return this.hasAttribute('loading'); }
    set loading(on) { this.toggleAttribute('loading', !!on); }

    /**
     * Convenience: feed an AskResult from `bot ask --request` / POST /ask. Renders the
     * component when there is one, the plain text otherwise, the error if it failed.
     */
    set result(res) {
      if (!res) return;
      if (res.ok === false) { this.error = `${res.error.code}: ${res.error.message}`; return; }
      if (res.structured && res.structured.component) { this.data = res.structured; return; }
      this.data = { component: { type: 'text', markdown: res.text || '' } };
    }

    _hit(e) {
      const seg = e.target.closest && e.target.closest('.seg[tabindex]');
      if (!seg || !this._data) return;
      const s = this._data.component.segments?.[Number(seg.dataset.i)];
      if (!s) return;
      this.dispatchEvent(new CustomEvent('lookup', { bubbles: true, composed: true,
        detail: { surface: s.surface, reading: s.reading ?? null, base: s.base ?? null, role: s.role || 'word' } }));
    }

    _render() {
      if (!this._root) return;
      if (this.loading) {
        // Classes, not style attributes: a host with a strict CSP blocks inline styles.
        this._root.innerHTML = '<div class="sk" aria-busy="true" aria-label="Explaining"><i class="l1"></i><i class="l2"></i><i class="l3"></i></div>';
        return;
      }
      if (this._error) { this._root.innerHTML = `<p class="error"><b>Couldn't explain.</b> ${esc(this._error)}</p>`; return; }
      const c = this._data && this._data.component;
      if (!c) { this._root.innerHTML = ''; return; }
      const render = R[c.type] || ((x) => `<div class="text"><p>${esc(JSON.stringify(x))}</p></div>`);
      this._root.innerHTML = `<div class="c c-${esc(c.type)}">${render(c)}</div>`;
    }
  }

  customElements.define('bot-answer', BotAnswer);
  if (typeof window !== 'undefined') window.BotAnswer = BotAnswer;
})();
