// An EPUB as the reading order of its text documents, unpacked to a directory
// so each document's relative stylesheets and images resolve as they do in a
// reader.

const fs = require('fs');
const path = require('path');

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Unpack `epub` into `dir` and return its linear, reflowable spine documents
 * as absolute paths. Pre-paginated items are skipped: in these light novels
 * they are the cover, the colour plates and the ads — pictures, no text.
 */
function unpack(epub, dir, zip) {
  const z = zip.open(epub);
  try {
    for (const name of z.names()) {
      if (name.endsWith('/')) continue;
      const out = path.join(dir, name);
      if (!out.startsWith(dir + path.sep)) continue;     // a ../ entry
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, z.read(name));
    }
  } finally { z.close(); }
  const container = fs.readFileSync(path.join(dir, 'META-INF', 'container.xml'), 'utf8');
  const opfRel = attr(container.match(/<rootfile\b[^>]*>/)[0], 'full-path');
  const opfPath = path.join(dir, opfRel);
  const opf = fs.readFileSync(opfPath, 'utf8');
  const items = new Map();
  for (const tag of opf.match(/<item\b[^>]*>/g) || []) {
    items.set(attr(tag, 'id'), { href: attr(tag, 'href'), type: attr(tag, 'media-type') });
  }
  const docs = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/g) || []) {
    if (attr(tag, 'linear') === 'no') continue;
    if (/pre-paginated/.test(attr(tag, 'properties') || '')) continue;
    const it = items.get(attr(tag, 'idref'));
    if (!it || !/xhtml|html/.test(it.type || '')) continue;
    docs.push(path.join(path.dirname(opfPath), decodeURIComponent(it.href)));
  }
  const vertical = /page-progression-direction="rtl"/.test(opf);
  return { docs, vertical };
}

module.exports = { unpack };
