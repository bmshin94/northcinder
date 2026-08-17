// Minimal ZIP writer (store + deflate), with no dependency added just for one bundle. Supports
// what build-mcpb.mjs needs: a flat list of {name, data} entries, deflate
// compression, and a valid End Of Central Directory record. Verified against
// Node's own `node:zlib` inflate + against `unzip -l`/`unzip -p` in tests.
import { deflateRawSync, inflateRawSync } from "node:zlib";

const DEFLATE = 8;

function dosDateTime(date = new Date()) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ~crc >>> 0;
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer} a complete, valid ZIP archive
 */
export function createZip(entries) {
  const { time, dosDate } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/**
 * Reads back a ZIP produced by createZip (or any standard ZIP with a single
 * disk + deflate/store entries) by walking the central directory. Test/
 * verification helper only — not a general-purpose unzip.
 * @param {Buffer} zipBuf
 * @returns {{name: string, data: Buffer}[]}
 */
export function readZipEntries(zipBuf) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("not a valid ZIP: no End Of Central Directory record found");
  const entryCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralStart = zipBuf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let ptr = centralStart;
  for (let i = 0; i < entryCount; i++) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("corrupt central directory entry");
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localOffset = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    const localNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = method === DEFLATE ? inflateRawSync(raw) : Buffer.from(raw);
    entries.push({ name, data });

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
