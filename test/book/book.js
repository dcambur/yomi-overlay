// A real book, read page by page, the way a reader uses the app: every page
// rendered as a reader shows it, recognised by the real bin/yomi, laid under
// the real overlay page as its glyph layer, and pointed at — Shift pressed —
// word by word. Each popup is checked against what the page's own text looks
// up, through the same lookup and the user's own dictionaries.
//
// Headless: the pages and the overlay are hidden windows, and recognition is
// `yomi --image` on each page's picture, so it needs no Screen Recording and
// runs while the overlay is up. At the main display's scale — 2x on a Retina
// laptop, which the screen lane's 1x display cannot show.
//
// Needs what cannot ship, so it is its own lane and never part of `all`:
//
//   YOMI_BOOK=/path/to/book.epub test/run.sh book
//     YOMI_BOOK_PAGES=100         pages per orientation (default 100)
//     YOMI_BOOK_WORDS=10          words pointed at per page (default 10)
//     YOMI_BOOK_MODES=vertical,horizontal   (default: both)
//     YOMI_BOOK_INDEX=path        the index to look up in (default: the app's)
//
// The report, and the picture of every page with a miss, land in
// bin/test/book/<mode>/.

const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'test', 'stage');
const { OCR_BIN, BIN_DIR, DATA_DIR, USER_DIR } = require(path.join(ROOT, 'app', 'paths.js'));
const { test, check, note, bounded, sleep, results } = require(path.join(STAGE, 'harness.js'));
const zip = require(path.join(ROOT, 'app', 'main', 'zip.js'));
const { unpack } = require('./epub.js');
const READER = require('./reader.js');
const score = require('./score.js');

const EPUB = process.env.YOMI_BOOK;
const PAGES = Number(process.env.YOMI_BOOK_PAGES || 100);
const PER_PAGE = Number(process.env.YOMI_BOOK_WORDS || 10);
const MODES = (process.env.YOMI_BOOK_MODES || 'vertical,horizontal').split(',');
const OUT = path.join(BIN_DIR, 'test', 'book');
// 15 minutes: two orientations of 100 pages take ~4 (measured 106 s and 135 s).
const LANE_LIMIT_MS = 15 * 60e3;

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

// A reader's page: portrait, 20 px Mincho, the book's own line height.
const W = 720, H = 880, MARGIN = 48;
const COLUMNS = `height: ${H - 2 * MARGIN}px !important; margin: ${MARGIN}px 0 !important;`;
const ROWS = `width: ${W - 2 * MARGIN}px !important; margin: 0 ${MARGIN}px !important;
              -webkit-writing-mode: horizontal-tb !important;`;
const readerCSS = (vertical) => `
  html { font-family: "Hiragino Mincho ProN", serif !important; font-size: 20px !important;
         overflow: hidden !important; background: #fff !important;
         ${vertical ? COLUMNS : ROWS} }
  body { margin: 0 !important; background: #fff !important; }
  img, svg { visibility: hidden !important; }
  ::-webkit-scrollbar { display: none; }`;

function yomiImage(png) {
  return new Promise((resolve, reject) => {
    const o = { timeout: 90000, maxBuffer: 64 << 20 };
    execFile(OCR_BIN, ['--image', png, '--json'], o, (e, out, err) => {
      if (e) { reject(new Error(`yomi --image: ${String(err).trim().slice(-200)}`)); return; }
      try { resolve(JSON.parse(out)); } catch (x) { reject(x); }
    });
  });
}

/** One orientation of the book, read and pointed at. */
async function readBook(vertical, docs, overlay, lookups) {
  const mode = vertical ? 'vertical' : 'horizontal';
  const out = path.join(OUT, mode);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const pngs = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-book-'));
  const book = new BrowserWindow({ show: false, x: 0, y: 0, width: W, height: H, frame: false,
                                   useContentSize: true,
                                   webPreferences: { backgroundThrottling: false } });
  const pages = [];
  let dpr = 1;
  try {
    // --- render: whole lines packed into pages, in reading order ----------
    for (const doc of docs) {
      if (pages.length >= PAGES) break;
      await book.loadFile(doc);
      await book.webContents.insertCSS(readerCSS(vertical));
      await sleep(80);
      await book.webContents.executeJavaScript(READER);
      const lines = await book.webContents.executeJavaScript('__book.lines()');
      const room = (vertical ? W : H) - 2 * MARGIN;
      const packed = [];
      let cur = null;
      for (const l of lines) {
        const a = Math.min(l.a, cur ? cur.a : l.a), b = Math.max(l.b, cur ? cur.b : l.b);
        if (cur && b - a <= room) { cur.a = a; cur.b = b; cur.lines.push(l); }
        else { cur = { a: l.a, b: l.b, lines: [l] }; packed.push(cur); }
      }
      for (const pg of packed) {
        if (pages.length >= PAGES) break;
        const at = vertical ? W - MARGIN : MARGIN;
        // Rubies sit right of a column: the page keeps its first column's.
        const pad = vertical ? '{ before: 4, after: 14 }' : '{ before: 2, after: 12 }';
        const shown = await book.webContents.executeJavaScript(
          `__book.show(${pg.a}, ${pg.b}, ${at}, ${pad})`);
        const shift = vertical ? at - pg.b : at - pg.a;
        await bounded(book.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'),
                      2000, 'a page to paint');
        const truth = await book.webContents.executeJavaScript(
          `__book.truth(${shown.from}, ${shown.to}, ${JSON.stringify(pg.lines)}, ${shift})`);
        if (!truth.some((l) => l.jp)) continue;
        const img = await book.webContents.capturePage();
        dpr = img.getSize().width / W;
        const png = path.join(pngs, `page-${String(pages.length).padStart(3, '0')}.png`);
        fs.writeFileSync(png, img.toPNG());
        pages.push({ n: pages.length, doc: path.basename(doc), png, truth });
      }
    }
  } finally { book.destroy(); }

  // --- recognise, three at a time --------------------------------------------
  let next = 0;
  const worker = async () => {
    while (next < pages.length) {
      const page = pages[next++];
      try { page.payload = await yomiImage(page.png); } catch (e) { page.error = e.message; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  // --- point at words ---------------------------------------------------------
  const ov = (js) => overlay.webContents.executeJavaScript(js);
  const origin = await ov('({ x: screenX, y: screenY })');
  const t = { chars: 0, placed: 0, cerNum: 0, cerDen: 0, words: 0, ok: 0, wrong: 0,
              noGlyph: 0, noResult: 0, geometry: 0 };
  const misses = [];
  for (const page of pages) {
    if (!page.payload) continue;
    // Device pixels to page points, the space the DOM truth is in.
    const lines = page.payload.lines.map((l) => ({ ...l, chars: l.chars.map((c) => ({
      ...c, x: c.x / dpr, y: c.y / dpr, w: c.w / dpr, h: c.h / dpr })) }));
    const truthText = page.truth.map((l) => l.text).join('');
    const n = score.glyphs(truthText).length;
    page.cer = score.cer(lines.filter((l) => !l.ruby).map((l) => l.text).join(''), truthText);
    t.cerNum += page.cer * n; t.cerDen += n;
    const pl = score.placement(page.truth, lines);
    t.chars += pl.total; t.placed += pl.placed;

    overlay.webContents.send('reset');
    overlay.webContents.send('offset', { fx: origin.x, fy: origin.y });
    const frame = { x: origin.x, y: origin.y, width: W, height: H };
    overlay.webContents.send('capture', { ...page.payload, lines, frame });
    const glyphs = lines.reduce((s, l) => s + l.chars.length, 0);
    await bounded((async () => {
      while ((await ov("document.querySelectorAll('.g').length")) !== glyphs) await sleep(10);
    })(), 5000, `page ${page.n}'s glyph layer`);

    const all = page.truth.flatMap((l, li) =>
      score.words(l, lookups.lookup).map((w) => ({ ...w, li })));
    page.words = [];
    for (const w of score.spread(all, PER_PAGE)) {
      const tl = page.truth[w.li];
      const c = tl.chars[w.at];
      overlay.webContents.send('dismiss');
      const before = lookups.asked.length;
      // A Shift press where the reader points, as the global monitor sends it.
      const at = { type: 'modifier', x: c.x + c.w / 2, y: c.y + c.h / 2 };
      overlay.webContents.send('trigger', at);
      // A span under the point asks main within a frame or two; none asks nothing.
      const end = Date.now() + 250;
      while (lookups.asked.length === before && Date.now() < end) await sleep(5);
      const call = lookups.asked[before];
      let shown = null;
      if (call && call.r) {
        const want = call.r.base || call.r.surface;
        shown = await bounded((async () => {
          for (;;) {
            const v = await ov(`(() => { const p = document.getElementById('popup');
              const t = p.querySelector('.card .term');
              return p.style.display === 'block' && t ? t.textContent : null; })()`);
            if (v === want) return v;
            await sleep(5);
          }
        })(), 2000, `the popup for ${want}`).catch(() => null);
      }
      const truth = tl.chars.slice(w.at, w.at + 12).map((q) => q.c).join('');
      const rec = { term: w.term, truth, asked: call ? call.g.join('') : null, shown };
      if (call) {
        // The line the pointed-at glyph is on, against the column the reader
        // pointed into: a miss on a line read right is the overlay's, not OCR's.
        const said = call.g.join('').replace(/\s/g, '');
        const ol = lines.find((l) => !l.ruby && l.text.replace(/\s/g, '').endsWith(said));
        rec.lineRight = !!ol && score.cer(ol.text, tl.text) === 0;
      }
      t.words++;
      if (!call) { rec.verdict = 'no-glyph'; t.noGlyph++; }
      else if (!call.r) { rec.verdict = 'no-result'; t.noResult++; }
      else if (shown === w.term || score.sameWord(call.r, w.r)) { rec.verdict = 'ok'; t.ok++; }
      else { rec.verdict = 'wrong'; t.wrong++; }
      if (rec.verdict !== 'ok' && rec.lineRight) t.geometry++;
      page.words.push(rec);
      if (rec.verdict !== 'ok') misses.push({ page: page.n, doc: page.doc, ...rec });
    }
    // The pages worth looking at are kept; the rest go with the run's TMPDIR.
    if (page.words.some((w) => w.verdict !== 'ok')) {
      fs.copyFileSync(page.png, path.join(out, path.basename(page.png)));
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
    book: path.basename(EPUB), mode, dpr, totals: t, misses,
    pages: pages.map((p) => ({ n: p.n, doc: p.doc, cer: p.cer, error: p.error,
                               words: p.words })),
  }, null, 1));
  fs.rmSync(pngs, { recursive: true, force: true });
  return { mode, pages, t, misses, dpr, out };
}

app.whenReady().then(async () => {
  const t0 = Date.now();
  setTimeout(() => {
    console.log(`FAIL  the book ran past ${LANE_LIMIT_MS / 60e3} minutes — stopped`);
    app.exit(1);
  }, LANE_LIMIT_MS);
  try {
    check(EPUB && fs.existsSync(EPUB), 'set YOMI_BOOK to an .epub to read');
    // The user's dictionaries, read only, ranked the way the user ranked them.
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-book-user-'));
    for (const f of ['config.json', 'dictionaries.json']) {
      if (fs.existsSync(path.join(USER_DIR, f))) {
        fs.copyFileSync(path.join(USER_DIR, f), path.join(userDir, f));
      }
    }
    const index = process.env.YOMI_BOOK_INDEX || path.join(USER_DIR, 'index.db');
    process.env.YOMI_USER_DIR = userDir;
    const lookupModule = require(path.join(ROOT, 'app', 'main', 'lookup.js'));
    check(fs.existsSync(index) && lookupModule.open(index),
          `no dictionary index at ${index} (${DATA_DIR}) — build one first`);
    const lookups = { asked: [], lookup: (g) => lookupModule.lookup(g, 12, null) };

    // The overlay page, as main runs it: the real preload, and main's side of
    // the channels a lookup uses, answered the way ipc.js answers them.
    ipcMain.handle('lookup', (_e, g, hint) => {
      const r = lookupModule.lookup(g, 12, hint ?? null);
      lookups.asked.push({ g, r });
      return r;
    });
    ipcMain.on('set-interactive', () => {});
    const webPreferences = { preload: path.join(ROOT, 'app', 'preload', 'overlay.js'),
                             contextIsolation: true, nodeIntegration: false,
                             backgroundThrottling: false };
    const overlay = new BrowserWindow({ show: false, x: 0, y: 0, width: W, height: H,
                                        frame: false, useContentSize: true, webPreferences });
    await overlay.loadFile(path.join(ROOT, 'app', 'renderer', 'index.html'));
    overlay.webContents.send('trigger-config', { modifier: 'shift', mode: 'hold',
                                                 hoverDelayMs: 250 });
    overlay.webContents.send('view-config', { images: false, anki: { enabled: false } });

    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-epub-'));
    const { docs } = unpack(EPUB, unpacked, zip);
    console.log(`${path.basename(EPUB)}: ${docs.length} text documents`);

    for (const mode of MODES) {
      const s = Date.now();
      const r = await readBook(mode === 'vertical', docs, overlay, lookups);
      const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
      console.log(`== ${mode}: ${r.pages.length} pages at ${r.dpr}x, `
                  + `${r.t.cerDen} characters, in ${((Date.now() - s) / 1000).toFixed(0)} s`);
      // The floors sit under what was measured on リビルドワールドI〈上〉 (2026-09-25):
      // CER 1.0% / 1.1%, 97.7% / 98.9% placed, 96.8% / 97.8% of words.
      await test(`${mode}: every page rendered was recognised`, () => {
        check(r.pages.length >= Math.min(PAGES, 20), `only ${r.pages.length} pages`);
        const bad = r.pages.filter((p) => !p.payload);
        check(!bad.length, `${bad.length} pages failed: ${bad[0] && bad[0].error}`);
      });
      await test(`${mode}: under 2% of characters misread`, () => {
        note(`CER ${pct(r.t.cerNum, r.t.cerDen)}`);
        check(r.t.cerNum / r.t.cerDen < 0.02, `CER ${pct(r.t.cerNum, r.t.cerDen)}`);
      });
      await test(`${mode}: 95% of characters have their glyph on them`, () => {
        note(`${pct(r.t.placed, r.t.chars)} placed`);
        check(r.t.placed / r.t.chars >= 0.95, `${pct(r.t.placed, r.t.chars)} placed`);
      });
      await test(`${mode}: 94% of the words pointed at open their own entry`, () => {
        note(`${r.t.ok}/${r.t.words} (${pct(r.t.ok, r.t.words)}); wrong word ${r.t.wrong}, `
             + `no glyph ${r.t.noGlyph}, no entry ${r.t.noResult}`);
        check(r.t.words >= r.pages.length * PER_PAGE * 0.5,
              `only ${r.t.words} words pointed at`);
        check(r.t.ok / r.t.words >= 0.94, `${pct(r.t.ok, r.t.words)} of words`);
      });
      await test(`${mode}: a word on a line read right opens its entry`, () => {
        const geo = r.misses.filter((m) => m.lineRight);
        note(`${r.misses.length - geo.length} misses on misread lines; report ${r.out}`);
        check(!geo.length, `${geo.length} misses on lines read right, e.g. `
              + `${JSON.stringify(geo[0])}`);
      });
    }
    fs.rmSync(unpacked, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  } catch (e) {
    results.push({ ok: false, name: 'setup', ms: 0 });
    console.log(`FAIL  setup\n        ${e.stack || e.message}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed in `
              + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  app.exit(failed ? 1 : 0);
});
