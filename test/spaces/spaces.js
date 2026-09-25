// Switching Spaces, slowly, quickly and aggressively — on the invisible display
// only, so the user's own Spaces never move.
//
// What a switch is, to this app, was measured before (ARCHITECTURE §2-3): the
// window server stops listing a window on another Space at all, or parks it off
// the desktop with a sliver left on screen, and a Space transition slides. So a
// switch is played here as the target window leaving the on-screen list (hide),
// being parked, sliding, and — the real thing — getting a fullscreen Space of
// its own on the invisible display. After each, the overlay must have left
// with the target, come back with it, and be lying on the real text again.
//
//   test/run.sh spaces

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'test', 'stage');
const { test, check, note, waitFor, sleep } = require(path.join(STAGE, 'harness.js'));
const { stageWindow, contentOrigin, serverRect, raise } =
  require(path.join(STAGE, 'display.js'));
const { EXTRACT, alignment, assertAligned } = require(path.join(STAGE, 'truth.js'));
const { appOnStage, watchPid, lookUp, LAYER, POPUP } = require(path.join(STAGE, 'app.js'));
const { runLane } = require(path.join(STAGE, 'lane.js'));
const { listAll } = require(path.join(STAGE, 'yomi.js'));
const { takingFocus } = require(path.join(STAGE, 'user-screen.js'));

// How long "with the target" may take, either way (ARCHITECTURE §3): the idle
// marker comes 68-224 ms after the target leaves (2.3 s at load 8), and the
// next pass puts the panel back.
const CEILING_MS = 4000;

runLane(async (D) => {
  const A = await stageWindow(path.join(STAGE, 'horizontal.html'),
                              { x: 120, y: 90, width: 1000, height: 700 });
  const B = await stageWindow('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:#eee;font:26px Hiragino Kaku Gothic ProN">'
    + '<p style="margin:60px">囮のウィンドウです</p>'),
                              { x: 180, y: 140, width: 1000, height: 700 });
  const home = A.win.getBounds();
  const park = { x: D.x + D.width + 400, y: D.y + 122, width: 1000, height: 700 };
  B.win.setBounds(park);
  await raise(A);

  const app = await appOnStage(A, { shim: true, stage: D });
  let cdp = null;
  try {
    cdp = await app.page();
    const shown = async () => (await cdp.eval('document.visibilityState')) === 'visible';
    const popupOpen = async () => (await cdp.eval(POPUP)).shown;
    const glyphs = () => cdp.eval("document.querySelectorAll('.g').length");
    await waitFor('the first glyph layer', glyphs, 20000);
    const pid = watchPid(app);

    /**
     * The layer lies on the page's text, as it is now. The truth is read
     * again on every try: just after leaving fullscreen the page is still
     * laying itself out, and a truth read then was 120,90 off for good.
     */
    async function onTheText(label) {
      const measure = async () => {
        const probes = await A.win.webContents.executeJavaScript(EXTRACT);
        return alignment(await cdp.eval(LAYER), { x: 0, y: 0 }, probes, await contentOrigin(A));
      };
      const a = await waitFor(`the layer on the text (${label})`, async () => {
        const r = await measure();
        return r.matched >= 8 && r.aligned / r.matched >= 0.7 && r.gross === 0 && r;
      }, CEILING_MS + 4000).catch(measure);
      if (a.gross || a.aligned / Math.max(1, a.matched) < 0.7) {
        // Where main and the page thought the target was, in their own words.
        const said = app.log().split('\n')
          .filter((l) => /target frame|layer@|place:|kept over|rebuild forced/.test(l)).slice(-8);
        note(`panel ${panelAt()}; target ${JSON.stringify(A.win.getBounds())}; the app said:`
             + `\n          ${said.join('\n          ')}`);
      }
      assertAligned(a, label);
    }
    /** Gone within the ceiling; how long it took. */
    async function leaves(what) {
      const t0 = Date.now();
      await waitFor(`the overlay to leave (${what})`, async () => !(await shown()), CEILING_MS);
      return Date.now() - t0;
    }
    async function returns(what) {
      const t0 = Date.now();
      await waitFor(`the overlay back (${what})`, shown, CEILING_MS);
      return Date.now() - t0;
    }
    const panelAt = () => listAll().filter((w) => w.title === 'Yomi overlay')
      .map((w) => `${w.x},${w.y} ${w.width}x${w.height}${w.onScreen ? '' : ' (off screen)'}`)
      .join('; ');
    const logged = (re) => app.log().split('\n').filter((l) => re.test(l)).length;

    await test('slow switches: away 2 s, back 2 s, three times', async () => {
      const times = [];
      for (let i = 0; i < 3; i++) {
        await lookUp(cdp, '猫');
        A.win.hide();
        const gone = await leaves('away');
        check(!(await popupOpen()), 'the popup stayed up over the other Space');
        await sleep(2000);
        A.win.showInactive();
        const back = await returns('back');
        times.push(`${gone}/${back}`);
        await sleep(300);
        check(!(await popupOpen()), 'the popup came back, pinned to a word nobody points at');
        await sleep(1700);
      }
      note(`left/back (ms): ${times.join(', ')}`);
      await onTheText('after slow switches');
    });

    await test('fast switches: away and back every 300 ms, ten times', async () => {
      const before = logged(/\[win\] (shown|hidden)/);
      for (let i = 0; i < 10; i++) {
        A.win.hide(); await sleep(300);
        A.win.showInactive(); await sleep(300);
      }
      await returns('after the last');
      await onTheText('after fast switches');
      const lines = logged(/\[win\] (shown|hidden)/) - before;
      note(`${lines} show/hide lines in the log for 10 switches`);
      check(watchPid(app) === pid, 'the capture child was restarted');
    });

    await test('aggressive switching: 60 flips 40 ms apart, then away, then back', async () => {
      const before = logged(/\[win\] (shown|hidden)/);
      for (let i = 0; i < 60; i++) {
        if (i % 2) A.win.showInactive(); else A.win.hide();
        await sleep(40);
      }
      A.win.hide();
      note(`away ${await leaves('after flapping')}ms after the last flip`);
      A.win.showInactive();
      note(`back ${await returns('after flapping')}ms after it`);
      await onTheText('after flapping');
      const lines = logged(/\[win\] (shown|hidden)/) - before;
      note(`${lines} show/hide lines in the log for 60 flips`);
      check(watchPid(app) === pid, 'the capture child was restarted');
    });

    await test('parked off the desktop, as another Space\'s window is, and back', async () => {
      A.win.setBounds(park);
      await leaves('parked');
      A.win.setBounds(home);
      await raise(A);
      await returns('unparked');
      await onTheText('after parking');
    });

    await test('a Space slide: the target arrives from off the display', async () => {
      // A transition moves the window in steps; a pass mid-slide reads a
      // transient x, and the layer must end where the window ends.
      for (let k = 10; k >= 0; k--) {
        A.win.setBounds({ ...home, x: home.x - k * 110 });
        await sleep(30);
      }
      await returns('after the slide');
      await onTheText('after the slide');
    });

    // Twice: the second exit is where a stale truth read first showed. macOS
    // makes an app whose window goes fullscreen the active one, so this takes
    // focus for its length, and gives it back.
    await test('a real Space: fullscreen on the invisible display, twice', () =>
      takingFocus('a window entering fullscreen', async () => {
        for (let i = 0; i < 2; i++) {
          const entered = new Promise((r) => A.win.once('enter-full-screen', r));
          A.win.setFullScreen(true);
          await entered;
          await waitFor('the fullscreen Space to settle', () => {
            const s = serverRect(A);
            return s && s.x === D.x && s.width === D.width;
          });
          await onTheText(`fullscreen ${i + 1}`);
          const left = new Promise((r) => A.win.once('leave-full-screen', r));
          A.win.setFullScreen(false);
          await left;
          await waitFor('the window back', () => {
            const s = serverRect(A);
            return s && s.width < D.width;
          });
          await onTheText(`left fullscreen ${i + 1}`);
        }
      }), 60000);

    await test('the page changed while its Space was away', async () => {
      A.win.hide();
      await leaves('away');
      await A.win.webContents.executeJavaScript('window.scrollTo(0, 420)');
      A.win.showInactive();
      await returns('back');
      await onTheText('scrolled while away');
      await A.win.webContents.executeJavaScript('window.scrollTo(0, 0)');
      await onTheText('scrolled back');
    });

    await test('another window over the reader and off it, six times fast', async () => {
      for (let i = 0; i < 6; i++) {
        B.win.setBounds(home); await raise(B);
        B.win.setBounds(park); await sleep(150);
      }
      await raise(A);
      await returns('uncovered');
      const p = await lookUp(cdp, '猫');
      check(p.text.includes('ねこ'), `a lookup after the covers: ${p.text.slice(0, 60)}`);
      check(watchPid(app) === pid, 'the capture child was restarted');
    });
  } finally {
    if (cdp) cdp.close();
    await app.quit();
  }
});
