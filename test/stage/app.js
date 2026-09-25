// The real app under test, reached through the DevTools protocol.

const fs = require('fs');
const path = require('path');
const { bounded, waitFor } = require('./harness.js');

/** Chrome DevTools Protocol on the app's overlay page. */
async function devtools(profile) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor('the app to open DevTools', () =>
    fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const target = await waitFor('the overlay page', async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && t.url.endsWith('/renderer/index.html'));
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await bounded(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
                3000, 'opening DevTools');
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  };
  const call = (method, params = {}) => bounded(new Promise((resolve, reject) => {
    seq++;
    pending.set(seq, { resolve, reject });
    ws.send(JSON.stringify({ id: seq, method, params }));
  }), 5000, `DevTools ${method}`);
  return {
    eval: async (expression) => {
      const r = await call('Runtime.evaluate',
                           { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    /** A pointer event delivered to the page itself: the real cursor stays put. */
    mouse: (type, x, y, extra = {}) =>
      call('Input.dispatchMouseEvent', { type, x, y, ...extra }),
    /** Kill the page's renderer process. The socket goes with it. */
    crash: () => { call('Page.crash').catch(() => {}); },
    close: () => ws.close(),
  };
}

// The glyph layer as lines of screen-space boxes, the shape alignment() reads.
const LAYER = `(() => {
  const byLine = {};
  for (const s of document.querySelectorAll('.g')) {
    const r = s.getBoundingClientRect();
    (byLine[s.dataset.li] = byLine[s.dataset.li] || []).push({ ci: +s.dataset.ci,
      c: s.textContent, x: r.left + screenX, y: r.top + screenY, w: r.width, h: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
  }
  return Object.values(byLine).map((cs) => {
    cs.sort((a, b) => a.ci - b.ci);
    return { text: cs.map((c) => c.c).join(''), chars: cs };
  });
})()`;

const POPUP = `(() => {
  const p = document.getElementById('popup');
  const b = p.querySelector('button.anki');
  const r = b && b.getBoundingClientRect();
  return { shown: getComputedStyle(p).display !== 'none', text: p.textContent,
           hits: document.querySelectorAll('.g.hit').length,
           mark: b && { state: b.dataset.state,
                        x: r.left + r.width / 2, y: r.top + r.height / 2 } };
})()`;
module.exports = { devtools, LAYER, POPUP };
