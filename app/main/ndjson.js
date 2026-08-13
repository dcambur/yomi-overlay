// NDJSON off a child's stdout.
//
// This was written out three times — once for the capture child, once for the
// event monitor, once for the tier-2 sidecar — and each copy had the same four
// steps and the same two easy mistakes: parsing a chunk instead of a line, and
// dropping the trailing partial line instead of carrying it.
//
// A chunk boundary falls wherever the pipe decides. `{"frame":{"x":0` is a
// perfectly ordinary read, and a payload with two thousand glyph boxes is
// several kilobytes, so the split is not hypothetical.

/**
 * Returns a `data` handler that calls `onObject` once per complete JSON line.
 *
 * Blank lines and unparseable lines are skipped rather than thrown: stdout is
 * a diagnostic surface as well as a data channel, and one bad line must not
 * take down the stream.
 */
function lineSplitter(onObject) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop();          // the trailing partial line, carried forward
    for (const line of parts) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      onObject(obj);
    }
  };
}

module.exports = { lineSplitter };
