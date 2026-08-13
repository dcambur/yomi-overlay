// NDJSON off a child's stdout.
//
// A chunk boundary falls wherever the pipe decides — `{"frame":{"x":0` is an
// ordinary read when a payload carries two thousand glyph boxes — so lines,
// not chunks, and the trailing partial is carried forward.

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
