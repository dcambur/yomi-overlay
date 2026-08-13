// Tier 2: the manga-ocr second opinion (INTEGRATION.md Phase 3).
//
// Shadow mode: on a lookup, the matched word's region is cropped by the watch
// process, read by the resident sidecar, and the disagreement with Tier 1 is
// LOGGED — the popup still shows Tier-1 text. Measured: whole lines make
// manga-ocr hallucinate (its ViT resizes to 224x224); word-sized crops read at
// ~14% CER in ~160ms, so only tight word regions are ever sent.

const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { TOOLS_DIR, VENV_DIR } = require('../paths.js');
const cfg = require('./config.js');
const { logf } = require('./log.js');

/**
 * Wire up the tier-2 shadow probe.
 *
 * `ocrChild` serves the crops: re-capturing would need a second
 * ScreenCaptureKit session and concurrent sessions stall, so the watch
 * process crops its own last frame.
 */
function createTier2({ ocrChild }) {
  let sidecar = null;
  let sidecarReady = false;
  let sidecarBuf = '';
  let sidecarDisabled = false;
  let sidecarIdleTimer = null;
  let tier2Seq = 0;
  let lastTier2At = 0;
  const tier2Pending = new Map();   // id -> {text, conf, t0}
  const tier2Queue = [];            // sidecar requests parked until ready

  function tier2Config() {
    const c = cfg.load().tier2 || {};
    return { mode: c.mode || 'shadow', idleKillMin: c.idleKillMin ?? 10 };
  }

  function editDistance(a, b) {
    const A = Array.from(a), B = Array.from(b);
    let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
    for (let i = 1; i <= A.length; i++) {
      const cur = [i];
      for (let j = 1; j <= B.length; j++) {
        cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)));
      }
      prev = cur;
    }
    return prev[B.length];
  }

  function stopSidecar(why) {
    if (!sidecar) return;
    logf('[tier2] stopping sidecar (' + why + ')');
    const p = sidecar; sidecar = null; sidecarReady = false;
    try { p.stdin.end(); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 2000);
  }

  function pokeSidecarIdle() {
    if (sidecarIdleTimer) clearTimeout(sidecarIdleTimer);
    const min = tier2Config().idleKillMin;
    // The model holds ~1GB resident; on an 8GB machine it must not outlive use.
    sidecarIdleTimer = setTimeout(() => stopSidecar('idle'), min * 60 * 1000);
  }

  function ensureSidecar() {
    if (sidecar || sidecarDisabled) return;
    const py = path.join(VENV_DIR, 'bin', 'python');
    const script = path.join(TOOLS_DIR, 'mangaocr_sidecar.py');
    let p;
    try { p = spawn(py, [script], { cwd: TOOLS_DIR }); }
    catch (e) { sidecarDisabled = true; logf('[tier2] spawn failed: ' + e.message); return; }
    sidecar = p; sidecarReady = false; sidecarBuf = '';
    logf('[tier2] sidecar starting (model load takes ~10s)');
    p.on('error', e => {
      logf('[tier2] error: ' + e.message);
      if (sidecar === p) { sidecar = null; sidecarDisabled = true; }
    });
    p.on('exit', code => {
      if (sidecar === p) { sidecar = null; sidecarReady = false; }
      if (code === 2 || code === 3) {
        // Import/model failure is not transient — degrade honestly, once.
        sidecarDisabled = true;
        logf('[tier2] sidecar unavailable (exit ' + code + '); tier2 off for this session. ' +
             'Run: reader/setup.sh (installs the sidecar venv under data/.venv)');
      } else if (code !== null && code !== 0) {
        logf('[tier2] sidecar exited ' + code + '; will respawn on next request');
      }
    });
    p.stderr.on('data', d => {
      const s = d.toString().trim();
      if (s) process.stderr.write('[tier2] ' + s + '\n');
    });
    p.stdout.on('data', chunk => {
      sidecarBuf += chunk.toString();
      const ls = sidecarBuf.split('\n');
      sidecarBuf = ls.pop();
      for (const l of ls) {
        if (!l.trim()) continue;
        let r;
        try { r = JSON.parse(l); } catch { continue; }
        if (r.ready) {
          sidecarReady = true;
          logf('[tier2] ready on ' + r.device);
          while (tier2Queue.length) p.stdin.write(tier2Queue.shift());
          continue;
        }
        const pend = tier2Pending.get(r.id);
        if (!pend) continue;
        tier2Pending.delete(r.id);
        if (r.error) { logf('[tier2] ocr error: ' + r.error); continue; }
        const t2 = (r.text || '').normalize('NFKC');
        const t1 = pend.text.normalize('NFKC');
        const d = editDistance(t1, t2);
        // The shadow signal. agree=yes rows build trust; d>0 rows are the
        // candidate corrections a future non-shadow mode would surface.
        logf(`[tier2] ${r.ms}ms d=${d} conf=${pend.conf.toFixed(2)} ` +
             `t1='${t1}' t2='${t2}' ${d === 0 ? 'agree' : 'DISAGREE'}`);
      }
    });
  }

  function onCropReply(c) {
    const pend = tier2Pending.get(c.id);
    if (!pend) return;
    if (!c.ok) { tier2Pending.delete(c.id); return; }
    ensureSidecar();
    if (sidecarDisabled || !sidecar) { tier2Pending.delete(c.id); return; }
    pokeSidecarIdle();
    const req = JSON.stringify({ id: c.id, image: c.path }) + '\n';
    if (sidecarReady) sidecar.stdin.write(req);
    else tier2Queue.push(req);
  }

  ipcMain.on('tier2', (_e, req) => {
    if (tier2Config().mode === 'off' || sidecarDisabled) return;
    // Frame-relative points from the renderer; a NaN here would become a
    // crop command the watch process cannot parse.
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!ocrChild.running || !req || typeof req !== 'object') return;
    if (![req.x, req.y, req.w, req.h].every(finite)) return;
    if (!(req.w > 0 && req.h > 0 && req.w < 4000 && req.h < 4000)) return;
    if (typeof req.text !== 'string' || req.text.length > 64) return;
    const now = Date.now();
    if (now - lastTier2At < 400) return;   // hover spam guard
    lastTier2At = now;
    const id = ++tier2Seq;
    tier2Pending.set(id, { text: String(req.text || ''), conf: +req.conf || 1, t0: now });
    // Frame-relative points, the same space the payload's char boxes use.
    const r = [req.x, req.y, req.w, req.h].map(v => Math.round(v)).join(' ');
    if (!ocrChild.write(`crop ${id} ${r} /tmp/yomi-t2-${id}.png\n`)) {
      tier2Pending.delete(id);
    }
  });

  return { onCropReply };
}

module.exports = { createTier2 };
