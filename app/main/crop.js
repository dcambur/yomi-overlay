// Pixels of the target, cut from the watch process's own last frame.
//
// Re-capturing would need a second ScreenCaptureKit session, and concurrent
// sessions stall, so the watch process serves crops of the frame it last
// captured, over its stdin (ocr/Sources/Capture/CropChannel.swift). The Anki
// card's picture is what asks (docs/ANKI.md).

/**
 * The crop channel on the capture child: `onCropReply` is fed the child's
 * `{crop: …}` lines, and `requestCrop` asks for one.
 */
function createCropChannel({ ocrChild }) {
  let cropSeq = 0;
  const cropWaiters = new Map();    // id -> resolve

  /**
   * A crop of the last frame, written to `file`. Resolves true when it is
   * there, false when the watch process is not running, could not be asked,
   * or did not answer within `waitMs` — never rejects.
   *
   * `rect` is frame-relative, the space the payload's char boxes use. The
   * path goes on the command line the crop reader splits on spaces, so a path
   * with one cannot be asked for.
   */
  function requestCrop(rect, file, waitMs) {
    return new Promise((resolve) => {
      if (!ocrChild.running || /\s/.test(file)) { resolve(false); return; }
      const id = ++cropSeq;
      const r = [rect.x, rect.y, rect.w, rect.h].map((v) => Math.round(v)).join(' ');
      const timer = setTimeout(() => { cropWaiters.delete(id); resolve(false); }, waitMs);
      cropWaiters.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
      if (!ocrChild.write(`crop ${id} ${r} ${file}\n`)) {
        clearTimeout(timer);
        cropWaiters.delete(id);
        resolve(false);
      }
    });
  }

  function onCropReply(c) {
    const waiter = cropWaiters.get(c.id);
    if (waiter) { cropWaiters.delete(c.id); waiter(!!c.ok); }
  }

  return { onCropReply, requestCrop };
}

module.exports = { createCropChannel };
