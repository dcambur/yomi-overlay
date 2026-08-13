// Deterministic alignment + selection test rig.
//
// Window A loads the REAL kakuyomu.jp homepage — real fonts, logos, images,
// carousel noise. Ground truth comes from its live DOM (getBoundingClientRect
// of actual text nodes), so assertions are exact without being synthetic.
//
// Window B is a same-bundle decoy of the same size (the "several Chrome
// windows" scenario): the selection test flips z-order between A and B and
// asserts yomi follows the frontmost window.
const { app, BrowserWindow } = require('electron');
const http = require('http');

const A = { x: 140, y: 90, width: 1160, height: 740 };
const B = { x: 200, y: 140, width: 1160, height: 740 };

let winA, winB;
// Vertical-text target. A panel joining every Space, because an ordinary
// window cannot appear on another app's fullscreen Space and the suite must
// run whatever Space is active. Vertical recognition is about OCR, not window
// selection, so the window type is irrelevant to what it measures.
let winV = null;
const V = { x: 260, y: 120, width: 900, height: 680 };

function ensureVertical() {
  if (winV && !winV.isDestroyed()) return winV;
  winV = new BrowserWindow({
    ...V, frame: false, resizable: false, type: 'panel', alwaysOnTop: true,
  });
  winV.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
  winV.setAlwaysOnTop(true, 'screen-saver');
  winV.loadFile('vertical.html');
  return winV;
}

// Probe extraction: single-line, directly-texted, fully-visible Japanese
// elements across the viewport. Runs inside the kakuyomu page.
const EXTRACT_VERTICAL = `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode()) && out.length < 400) {
    const t = n.textContent;
    for (let i = 0; i < t.length; i++) {
      if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(t[i])) continue;
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

const EXTRACT = `(() => {
  const re = /[\\u3040-\\u30ff\\u4e00-\\u9fff]{3,}/;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (out.length >= 60) break;
    const textNodes = Array.from(el.childNodes).filter(n => n.nodeType === 3);
    const t = textNodes.map(n => n.textContent).join('').replace(/\\s+/g, '');
    if (!re.test(t)) continue;
    // Measure the TEXT, not the element box: a centered or padded block's
    // element rect can sit hundreds of px left of its glyphs.
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
    if (r.width < 20 || r.height < 10 || fs < 11) continue;
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
    if (r.height > fs * 1.9) continue;               // multi-line: ambiguous anchor
    if (getComputedStyle(el).writingMode.startsWith('vertical')) continue;
    out.push({ text: t.slice(0, 24), x: Math.round(r.x), y: Math.round(r.y),
               h: Math.round(r.height), fs: Math.round(fs) });
  }
  return out;
})()`;

app.whenReady().then(() => {
  winA = new BrowserWindow({ ...A, frame: false, resizable: false });
  winA.loadURL('https://kakuyomu.jp');
  winB = new BrowserWindow({ ...B, frame: false, resizable: false, show: true });
  winB.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="background:#eee;font-family:Hiragino Kaku Gothic ProN">' +
    '<div style="position:absolute;left:60px;top:60px;font-size:26px">囮のウィンドウです</div>' +
    '<div style="position:absolute;left:80px;top:300px;font-size:22px">偽物の内容注意</div></body>'));
  // Join every Space, so the rig is testable no matter which Space happens to
  // be active when the suite runs (an editor in fullscreen would otherwise
  // leave both windows uncomposited and every case trivially "not capturable").
  for (const w of [winA, winB]) {
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
  }
  setTimeout(() => winA.moveTop(), 500);

  http.createServer(async (req, res) => {
    try {
      if (req.url === '/bounds') {
        res.end(JSON.stringify({ a: winA.getBounds(), b: winB.getBounds() }));
      } else if (req.url === '/front/a') {
        winA.moveTop(); res.end('ok');
      } else if (req.url === '/front/b') {
        winB.moveTop(); res.end('ok');
      } else if (req.url === '/vertical') {
        ensureVertical();
        setTimeout(() => res.end('ok'), 1200);
      } else if (req.url === '/vertical/close') {
        if (winV && !winV.isDestroyed()) winV.close();
        winV = null;
        res.end('ok');
      } else if (req.url === '/vertical/bounds') {
        const w = ensureVertical();
        const p = await w.webContents.executeJavaScript(
          '({sx: window.screenX, sy: window.screenY, iw: innerWidth, ih: innerHeight})');
        res.end(JSON.stringify({ bounds: w.getBounds(), ...p }));
      } else if (req.url === '/domchars') {
        res.end(JSON.stringify(
          await ensureVertical().webContents.executeJavaScript(EXTRACT_VERTICAL)));
      } else if (req.url === '/dom') {
        res.end(JSON.stringify(await winA.webContents.executeJavaScript(EXTRACT)));
      } else if (req.url.startsWith('/scroll/')) {
        const n = parseInt(req.url.split('/')[2], 10);
        await winA.webContents.executeJavaScript(`window.scrollTo(0, ${n})`);
        res.end('ok');
      } else if (req.url === '/park') {
        // Park the decoy off the desktop, the way the window server parks
        // windows belonging to another Space. Such a window must never be
        // chosen as the capture target.
        winB.setBounds({ x: -1500, y: 122, width: 1160, height: 740 });
        winB.moveTop();
        setTimeout(() => res.end('ok'), 600);
      } else if (req.url === '/unpark') {
        winB.setBounds(B);
        setTimeout(() => res.end('ok'), 600);
      } else if (req.url === '/fullscreen') {
        winA.setFullScreen(true);
        setTimeout(() => res.end('ok'), 1500);   // Space transition animates
      } else if (req.url === '/windowed') {
        winA.setFullScreen(false);
        // macOS drops the all-Spaces collection behaviour across a fullscreen
        // transition; without re-applying it the rig becomes uncapturable from
        // whatever Space the test runner happens to be on.
        setTimeout(() => {
          for (const w of [winA, winB]) {
            w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
          }
          res.end('ok');
        }, 1500);
      } else if (req.url === '/contentorigin') {
        // Absolute screen position of the web contents' (0,0). For a frameless
        // window this equals the window origin; for real apps with title bars
        // it does not — the test must not assume they are the same.
        const p = await winA.webContents.executeJavaScript(
          '({sx: window.screenX, sy: window.screenY, iw: innerWidth, ih: innerHeight})');
        res.end(JSON.stringify(p));
      } else if (req.url === '/quit') {
        res.end('bye'); setTimeout(() => app.quit(), 100);
      } else { res.statusCode = 404; res.end(); }
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  }).listen(43199, '127.0.0.1');
});
