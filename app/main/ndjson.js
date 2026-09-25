// NDJSON off a child's stdout.
//
// A chunk boundary falls wherever the pipe decides — `{"frame":{"x":0` is an
// ordinary read when a payload carries two thousand glyph boxes — so lines,
// not chunks, and the trailing partial is carried forward.

const { StringDecoder } = require('string_decoder');

/**
 * Returns a `data` handler that calls `onObject` once per complete JSON line.
 *
 * Blank lines and unparseable lines are skipped rather than thrown: stdout is
 * a diagnostic surface as well as a data channel, and one bad line must not
 * take down the stream.
 */
function lineSplitter(onObject) {
  // Decoded as a stream, not chunk by chunk: a boundary can fall inside a
  // character, and each half decoded alone is U+FFFD. Measured: a payload over
  // 64 KB (7 of 116 live layers) arrives as 65536 bytes and the rest, and in 3
  // of 16 such cuts through dense corpus pages byte 65536 was mid-character —
  // ニ arrived as ���.
  const utf8 = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += utf8.write(chunk);
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
