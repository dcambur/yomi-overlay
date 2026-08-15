// Images that live inside a dictionary archive, served straight out of it.
//
// The monolinguals draw a lot of their meaning: 三省堂 ships its sense markers
// and part-of-speech logos as SVG, 旺文社 its stroke-order diagrams as PNG,
// Jitendex its kanji illustrations as AVIF. 3,541 files across the installed
// set, and only about a third carry a title to fall back on — so without them
// two thirds of the images in a monolingual entry are simply missing.
//
// *** Nothing is extracted to disk. ***
//
// The obvious design is to unpack the media at import: it is also 137 MB on
// top of a 549 MB index, a second copy to keep in step with the archive, and
// another thing to delete when a dictionary is removed. zip.js reads one
// entry without reading the rest (that is why it was made lazy), so an image
// request is a seek and an inflate — and the media cannot go stale, because
// there is only ever one copy of it.
//
// What that costs is an open archive per dictionary being read from. The
// handles are cached and bounded, and dropped whenever the dictionaries
// change; a leaked one is not academic, since running out of descriptors stops
// the app opening a dictionary or spawning the capture helper.

const path = require('path');
const zip = require('./zip.js');
const { logf } = require('./log.js');

/** MIME types for what dictionaries actually ship. */
const TYPES = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
};

// A popup shows images from one dictionary at a time, occasionally two; three
// is enough to keep a scroll through several dictionaries from reopening an
// archive per image, and small enough to be obviously bounded.
const MAX_OPEN = 3;
const open = new Map();   // label -> archive handle, most recent last

/** The archive for a dictionary, opened at most once until the set changes. */
function archiveFor(label, dictionaries) {
  const hit = open.get(label);
  if (hit) return hit;
  const entry = dictionaries.installed().find((d) => d.label === label);
  if (!entry) return null;
  let z;
  try {
    z = zip.open(path.join(dictionaries.DICTS_DIR, entry.file));
  } catch (e) {
    logf(`[media] cannot open ${entry.file}: ${e.message}`);
    return null;
  }
  open.set(label, z);
  while (open.size > MAX_OPEN) {
    const oldest = open.keys().next().value;
    try { open.get(oldest).close(); } catch { /* already closed */ }
    open.delete(oldest);
  }
  return z;
}

/** Drop every open archive. Called whenever the installed set changes. */
function forget() {
  for (const z of open.values()) {
    try { z.close(); } catch { /* already closed */ }
  }
  open.clear();
}

/**
 * Answer one yomi-media:// request.
 *
 * The URL is the one structured.js builds: yomi-media://media/<dictionary>/<path
 * inside the archive>. The path is never used to touch the filesystem — it is
 * looked up in the archive's own directory, so a name like ../../etc/passwd
 * simply is not an entry and the request 404s.
 */
function serve(url, dictionaries) {
  const parts = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
  const label = parts.shift();
  const name = parts.join('/');
  if (!label || !name) return new Response('bad media path', { status: 400 });

  const z = archiveFor(label, dictionaries);
  if (!z) return new Response('no such dictionary', { status: 404 });
  let bytes;
  try {
    bytes = z.read(name);
  } catch {
    // Missing entry, or a compression method we do not read. Either way the
    // popup gets nothing rather than a broken-image box.
    return new Response('no such image', { status: 404 });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
      // The archive is the only copy; a rebuild does not change its images.
      'cache-control': 'max-age=3600',
    },
  });
}

module.exports = { serve, forget, SCHEME: 'yomi-media' };
