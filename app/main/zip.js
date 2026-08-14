// Reading a Yomitan dictionary archive, with nothing but node:zlib.
//
// The app ships zero runtime npm dependencies and this is not the place to
// start: Yomitan pulls in zip.js and the Python indexer used the stdlib, so a
// dictionary importer that needed a package would be the only one of the three
// that did. A zip central directory is a fixed-layout structure and DEFLATE is
// in node:zlib, so reading one is arithmetic, not a library.
//
// Deliberately NOT extracting to disk with `ditto`: a term bank archive expands
// several times over (jitendex is 38 MB packed), and every byte of that is read
// once and thrown away. Inflating entries straight into memory skips the churn
// and the temp-directory cleanup.
//
// CRC is read but never verified. That is not laziness — build-index.py carries
// the same tolerance, with its reason: some redistributed archives (the NHK
// 2016 pitch pack is the known one) fail CRC while containing perfectly valid
// JSON, a repacking artifact. Refusing them would drop a working dictionary
// over a checksum that no longer describes anything.

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;

/** Where the end-of-central-directory record starts, scanning back from EOF. */
function findEOCD(buf) {
  // The record is 22 bytes plus a comment of up to 65535. Scan back over the
  // largest legal window rather than assuming no comment.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * The entries in a zip, as a Map of name -> {offset, method, size}.
 *
 * Zip64 is handled because a dictionary can exceed the 16-bit entry count:
 * jitendex ships hundreds of term banks today and nothing stops a larger one
 * crossing 65535. The classic record signals that by storing 0xffff/0xffffffff
 * and putting the real values in a zip64 record before it.
 */
function centralDirectory(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)');

  let count = buf.readUInt16LE(eocd + 10);
  let start = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || start === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === EOCD64_LOCATOR_SIG) {
      const at = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(at) !== EOCD64_SIG) throw new Error('bad zip64 record');
      count = Number(buf.readBigUInt64LE(at + 32));
      start = Number(buf.readBigUInt64LE(at + 48));
    }
  }

  const entries = new Map();
  let p = start;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let size = buf.readUInt32LE(p + 20);          // compressed
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // Oversized values live in the zip64 extra field, tag 0x0001, holding
    // whichever of uncompressed/compressed/offset overflowed, in that order.
    if (size === 0xffffffff || offset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const tag = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (tag === 0x0001) {
          let q = e + 4;
          q += 8;                                  // uncompressed, unused here
          if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(buf.readBigUInt64LE(q)); }
          break;
        }
        e += 4 + len;
      }
    }

    entries.set(name, { offset, method, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** An opened archive: the names it holds, and the bytes behind each one. */
function open(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const entries = centralDirectory(buf);

  function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`no such entry: ${name}`);
    // The central directory's name/extra lengths describe the CENTRAL record;
    // the local header repeats them with its own values, and only those say
    // where the data really begins.
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    const at = e.offset + 30 + nameLen + extraLen;
    const raw = buf.subarray(at, at + e.size);
    if (e.method === 0) return raw;                // stored
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported compression method ${e.method} for ${name}`);
  }

  return {
    names: () => [...entries.keys()],
    read,
    readJSON: (name) => JSON.parse(read(name).toString('utf8')),
  };
}

module.exports = { open };
