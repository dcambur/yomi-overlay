const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onCapture: (cb) => ipcRenderer.on('capture', (_e, payload) => cb(payload)),
  // Target window frame origin in absolute screen coordinates ({fx, fy}).
  // Arrives independently of captures because a static page produces nothing
  // but heartbeats, and the layer still has to track the window.
  onOffset: (cb) => ipcRenderer.on('offset', (_e, off) => cb(off)),
  // Shift press / click observed globally, already converted to window coords.
  onTrigger: (cb) => ipcRenderer.on('trigger', (_e, ev) => cb(ev)),
  // {modifier, mode, hoverDelayMs} — which key arms a lookup, or whether to
  // look up on dwell with no key at all.
  onTriggerConfig: (cb) => ipcRenderer.on('trigger-config', (_e, t) => cb(t)),
  // Target changed — the glyph layer describes a window we no longer track.
  onReset: (cb) => ipcRenderer.on('reset', () => cb()),
  // `glyphs` is the array of per-character strings from the cursor to end of
  // line, not a joined string: match lengths must come back in glyphs so they
  // index spans directly, which a UTF-16 offset cannot do.
  // `hint` is the furigana text printed beside the source line, if any.
  lookup: (glyphs, hint) => ipcRenderer.invoke('lookup', glyphs, hint || null),
  setInteractive: (v) => ipcRenderer.send('set-interactive', !!v),
  // Tier-2 shadow probe (Phase 3): the matched word's frame-relative rect +
  // its Tier-1 text; main crops the region and asks the manga-ocr sidecar
  // for a second opinion. Fire-and-forget — the result is only logged.
  tier2: (req) => ipcRenderer.send('tier2', req),
});
