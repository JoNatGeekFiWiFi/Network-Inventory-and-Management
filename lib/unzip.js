// Minimal ZIP reader — just enough to pull the KML out of a KMZ.
//
// Node has no built-in ZIP support and this is the only archive we ever read, so a dependency
// isn't justified. We parse via the CENTRAL DIRECTORY rather than local headers: when a writer
// sets the streaming flag (bit 3) the local header's sizes are zero and the real values live in
// a trailing data descriptor, whereas the central directory is always authoritative.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

/** List entries as [{ name, compression, compSize, uncompSize, offset }]. */
export function listZipEntries(buf) {
  // EOCD sits at the very end, after an optional comment of up to 64KB — scan backwards for it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/KMZ archive (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const compression = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    entries.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), compression, compSize, uncompSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry (stored or deflate) to a Buffer. */
export function readZipEntry(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== LFH_SIG) throw new Error('Corrupt archive: bad local header');
  // the local header's own name/extra lengths tell us where the data actually starts
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.compression === 0) return Buffer.from(raw);          // stored
  if (entry.compression === 8) return inflateRawSync(raw);       // deflate
  throw new Error('Unsupported compression method ' + entry.compression + ' in archive');
}

/**
 * Pull the KML document out of a KMZ. Per the spec the main document is the first .kml at the
 * root, conventionally doc.kml — prefer that, then any other .kml.
 */
export function extractKmlFromKmz(buf) {
  const entries = listZipEntries(buf).filter(e => !e.name.endsWith('/'));
  const kmls = entries.filter(e => e.name.toLowerCase().endsWith('.kml'));
  if (!kmls.length) throw new Error('No .kml file inside that KMZ');
  const pick = kmls.find(e => e.name.toLowerCase() === 'doc.kml')
    || kmls.find(e => !e.name.includes('/'))
    || kmls[0];
  return readZipEntry(buf, pick).toString('utf8');
}

/** KMZ/ZIP files start with the local-file-header magic "PK\x03\x04". */
export const looksLikeZip = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === LFH_SIG;
