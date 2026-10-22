import { crc32 } from '../util/crc32';

/** One track's bits, one per byte. */
export interface WozTrack {
  bits: Uint8Array;
}

export interface WozDisk {
  version: 1 | 2;
  /** For each quarter-track position (0-159), the index of its track, or -1 for none. */
  quarterTracks: Int16Array;
  tracks: WozTrack[];
  writeProtected: boolean;
  /** The bit cell width the disk was written with, in 125 ns units (32 is the usual 4 µs). */
  bitTiming: number;
  /** The INFO and META chunks, kept so a saved disk keeps them. */
  info: Uint8Array;
  meta: Uint8Array | null;
}

const WOZ1 = 0x315a4f57;
const WOZ2 = 0x325a4f57;
const QUARTER_TRACKS = 160;
const WOZ1_TRACK_BYTES = 6656;
const WOZ1_BITSTREAM_BYTES = 6646;
const BLOCK = 512;

export function isWoz(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const magic = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
  return (magic === WOZ1 || magic === WOZ2) && data[4] === 0xff && data[5] === 0x0a && data[6] === 0x0d && data[7] === 0x0a;
}

function unpackBits(bytes: Uint8Array, count: number): Uint8Array {
  const bits = new Uint8Array(count);
  for (let i = 0; i < count; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

function packBits(bits: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 0x80 >> (i & 7);
  return bytes;
}

/** Reads a WOZ 1 or 2 image of a 5.25" disk. */
export function parseWoz(data: Uint8Array): WozDisk {
  if (!isWoz(data)) throw new Error('Not a WOZ disk image.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint32(0, true) === WOZ1 ? 1 : 2;
  const chunks = new Map<string, Uint8Array>();
  for (let at = 12; at + 8 <= data.length; ) {
    const id = String.fromCharCode(...data.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    chunks.set(id, data.subarray(at + 8, Math.min(data.length, at + 8 + size)));
    at += 8 + size;
  }
  const info = chunks.get('INFO');
  const tmap = chunks.get('TMAP');
  const trks = chunks.get('TRKS');
  if (!info || !tmap || !trks) throw new Error('That WOZ image is missing its INFO, TMAP or TRKS chunk.');
  if (info[1] !== 1) throw new Error('That WOZ image is of a 3.5" disk; only 5.25" disks fit the Disk II.');

  const tracks: WozTrack[] = [];
  if (version === 1) {
    for (let at = 0; at + WOZ1_TRACK_BYTES <= trks.length; at += WOZ1_TRACK_BYTES) {
      const bitCount = trks[at + 6648] | (trks[at + 6649] << 8);
      tracks.push({ bits: unpackBits(trks.subarray(at, at + WOZ1_BITSTREAM_BYTES), bitCount) });
    }
  } else {
    const trksAt = trks.byteOffset - data.byteOffset;
    for (let i = 0; i < QUARTER_TRACKS; i++) {
      const entry = trksAt + i * 8;
      const startBlock = view.getUint16(entry, true);
      const bitCount = view.getUint32(entry + 4, true);
      if (startBlock === 0 || bitCount === 0) break;
      const start = startBlock * BLOCK;
      tracks.push({ bits: unpackBits(data.subarray(start, start + Math.ceil(bitCount / 8)), bitCount) });
    }
  }
  const quarterTracks = new Int16Array(QUARTER_TRACKS);
  for (let i = 0; i < QUARTER_TRACKS; i++) quarterTracks[i] = tmap[i] < tracks.length ? tmap[i] : -1;
  return {
    version,
    quarterTracks,
    tracks,
    writeProtected: info[2] === 1,
    bitTiming: version === 2 && info[39] ? info[39] : 32,
    info: info.slice(),
    meta: chunks.get('META')?.slice() ?? null,
  };
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  out.set([...id].map((c) => c.charCodeAt(0)));
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/** Writes a disk as a WOZ 2 image. */
export function buildWoz(disk: Omit<WozDisk, 'version'>): Uint8Array {
  const info = new Uint8Array(60);
  info.set(disk.info.subarray(0, 60));
  info[0] = 2;
  info[1] = 1;
  info[2] = disk.writeProtected ? 1 : 0;
  if (!info[39]) info[39] = disk.bitTiming;
  const packed = disk.tracks.map((track) => packBits(track.bits));
  const blocksOf = (bytes: Uint8Array) => Math.ceil(bytes.length / BLOCK);
  info.set([0, 0], 44);
  new DataView(info.buffer).setUint16(44, Math.max(0, ...packed.map(blocksOf)), true);
  if (!info[37]) info[37] = 1;
  if (!(info[5] | info[6])) info.set([...'Apple II emulator'.padEnd(32)].map((c) => c.charCodeAt(0)), 5);

  const tmap = new Uint8Array(QUARTER_TRACKS).fill(0xff);
  disk.quarterTracks.forEach((track, i) => {
    if (track >= 0) tmap[i] = track;
  });

  // Track data starts at block 3: the header, INFO, TMAP and the TRKS table fit in the first 1536 bytes.
  const table = new Uint8Array(QUARTER_TRACKS * 8);
  const tableView = new DataView(table.buffer);
  let block = 3;
  packed.forEach((bytes, i) => {
    tableView.setUint16(i * 8, block, true);
    tableView.setUint16(i * 8 + 2, blocksOf(bytes), true);
    tableView.setUint32(i * 8 + 4, disk.tracks[i].bits.length, true);
    block += blocksOf(bytes);
  });
  const trackData = new Uint8Array((block - 3) * BLOCK);
  packed.forEach((bytes, i) => trackData.set(bytes, (tableView.getUint16(i * 8, true) - 3) * BLOCK));
  const trks = new Uint8Array(table.length + trackData.length);
  trks.set(table);
  trks.set(trackData, table.length);

  const parts = [chunk('INFO', info), chunk('TMAP', tmap), chunk('TRKS', trks)];
  if (disk.meta) parts.push(chunk('META', disk.meta));
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  const out = new Uint8Array(12 + body.length);
  out.set([0x57, 0x4f, 0x5a, 0x32, 0xff, 0x0a, 0x0d, 0x0a]);
  out.set(body, 12);
  new DataView(out.buffer).setUint32(8, crc32(body), true);
  return out;
}
