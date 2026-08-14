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

/**
 * Read `len` bytes at `at`, without pulling the rest of the file in with them.
 *
 * The first version of this read the whole archive with readFileSync, which is
 * fine for a term bank and absurd for a listing: opening the settings window
 * read 207 MB to learn eight names, and froze the main process for ~1 second
 * doing it. A zip is designed to be read from the end, so read from the end.
 */
function readAt(fd, at, len) {
  const buf = Buffer.allocUnsafe(len);
  fs.readSync(fd, buf, 0, len, at);
  return buf;
}

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
 * Parse a central directory that has been read on its own.
 *
 * Given only the directory bytes rather than the whole file, so `p` is relative
 * to the directory's start and no offset arithmetic depends on where the file
 * happened to end. The first version reconstructed a full-size buffer with the
 * directory pasted into it; on any archive small enough for the tail read to
 * cover the whole file that prepended padding and shifted every offset, which
 * is why most archives listed zero entries.
 */
function parseCentralDirectory(cd, count) {
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CENTRAL_SIG) break;
    const method = cd.readUInt16LE(p + 10);
    let size = cd.readUInt32LE(p + 20);          // compressed
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

    // Oversized values live in the zip64 extra field, tag 0x0001, holding
    // whichever of uncompressed/compressed/offset overflowed, in that order.
    if (size === 0xffffffff || offset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const stop = e + extraLen;
      while (e + 4 <= stop) {
        const tag = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (tag === 0x0001) {
          let q = e + 4;
          q += 8;                                 // uncompressed, unused here
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); }
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

/**
 * An opened archive: the names it holds, and the bytes behind each one.
 *
 * Only the directory is read up front — a few kilobytes at the end of the file
 * — and an entry's bytes are fetched when something asks for them. Listing a
 * 118 MB dictionary therefore costs a couple of reads rather than 118 MB.
 */
function open(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  let entries;
  try {
    const size = fs.fstatSync(fd).size;
    // The record is 22 bytes plus a comment of up to 65535; reading that much
    // of the tail finds it whatever the comment.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    const at = findEOCD(tail);
    if (at < 0) throw new Error('not a zip file (no end-of-central-directory)');

    let count = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdStart = tail.readUInt32LE(at + 16);

    // Zip64: the classic record stores 0xffff/0xffffffff and the real values
    // live in a record the locator just before it points at. A dictionary can
    // cross 65535 entries — 旺文社 already ships 2,609.
    if (count === 0xffff || cdStart === 0xffffffff || cdSize === 0xffffffff) {
      const loc = at - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === EOCD64_LOCATOR_SIG) {
        const rec = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = readAt(fd, rec, 56);
        if (z64.readUInt32LE(0) !== EOCD64_SIG) throw new Error('bad zip64 record');
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdStart = Number(z64.readBigUInt64LE(48));
      }
    }
    entries = parseCentralDirectory(readAt(fd, cdStart, cdSize), count);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }

  function read(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`no such entry: ${name}`);
    // The central directory's name/extra lengths describe the CENTRAL record;
    // the local header repeats them with its own values, and only those say
    // where the data really begins.
    const local = readAt(fd, e.offset, 30);
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const raw = readAt(fd, e.offset + 30 + nameLen + extraLen, e.size);
    if (e.method === 0) return raw;                // stored
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`unsupported compression method ${e.method} for ${name}`);
  }

  /**
   * The first `bytes` of an entry, without decompressing the rest.
   *
   * Classifying a dictionary means looking at the second field of its first
   * record, and doing that by parsing the whole bank cost 900 ms on BCCWJ,
   * whose first bank holds 1,000,219 records — about 100 MB of JSON, parsed to
   * read one word. Inflating a truncated deflate stream with Z_SYNC_FLUSH
   * returns what it managed rather than complaining the stream ended early.
   */
  function readPrefix(name, bytes = 64 * 1024) {
    const e = entries.get(name);
    if (!e) throw new Error(`no such entry: ${name}`);
    const local = readAt(fd, e.offset, 30);
    const at = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const want = Math.min(e.size, bytes);
    const raw = readAt(fd, at, want);
    if (e.method === 0) return raw;
    return zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }

  return {
    names: () => [...entries.keys()],
    read,
    readPrefix,
    readJSON: (name) => JSON.parse(read(name).toString('utf8')),
    close: () => { try { fs.closeSync(fd); } catch { /* already closed */ } },
  };
}

module.exports = { open };
