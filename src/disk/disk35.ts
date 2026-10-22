import { NibbleWriter, trackNibbles } from './nibble';

export const CYLINDERS = 80;
export const SIDES = 2;
export const BLOCK_BYTES = 512;
export const DISK35_BLOCKS = 1600;
export const DISK35_BYTES = DISK35_BLOCKS * BLOCK_BYTES;
/** A sector carries 12 tag bytes (unused by ProDOS) before its 512 data bytes. */
const TAG_BYTES = 12;
const SECTOR_BYTES = TAG_BYTES + BLOCK_BYTES;
/** The 524 bytes are written as 699 disk bytes: 174 groups of three bytes in four, then two in three. */
const ENCODED_BYTES = 699;
/** The format byte of a double-sided disk with 2:1 interleave. */
const FORMAT_800K = 0x22;
/** 2IMG files start with this header. */
const TWO_IMG_MAGIC = '2IMG';
const TWO_IMG_HEADER = 64;
/** At 2 µs a bit, what a track holds at each zone's speed (394, 429, 472, 525 and 590 rpm). */
const ZONE_TRACK_BITS = [76_150, 69_930, 63_560, 57_140, 50_850];

const WRITE_TABLE = [
  0x96, 0x97, 0x9a, 0x9b, 0x9d, 0x9e, 0x9f, 0xa6, 0xa7, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xcb, 0xcd, 0xce, 0xcf, 0xd3,
  0xd6, 0xd7, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe5, 0xe6, 0xe7, 0xe9, 0xea, 0xeb, 0xec,
  0xed, 0xee, 0xef, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const READ_TABLE = new Int8Array(256).fill(-1);
WRITE_TABLE.forEach((nibble, value) => (READ_TABLE[nibble] = value));

/** Sectors per track: 12 on the outer 16 cylinders, one fewer for each zone of 16 further in. */
export function sectorsOnCylinder(cylinder: number): number {
  return 12 - (cylinder >> 4);
}

/** The first block on a track (cylinder by cylinder, side 0 then side 1). */
function firstBlock(cylinder: number, side: number): number {
  let block = 0;
  for (let c = 0; c < cylinder; c++) block += sectorsOnCylinder(c) * SIDES;
  return block + side * sectorsOnCylinder(cylinder);
}

/** The sectors in the order they pass the head: 2:1 interleave. */
function interleave(sectors: number): number[] {
  const order = new Array<number>(sectors).fill(-1);
  let at = 0;
  for (let sector = 0; sector < sectors; sector++) {
    while (order[at] !== -1) at = (at + 1) % sectors;
    order[at] = sector;
    at = (at + 2) % sectors;
  }
  return order;
}

/** The checksums' four values: written as a group of three bytes like the data, last checksum first. */
function checksumValues(c1: number, c2: number, c3: number): number[] {
  return [((c3 & 0xc0) >> 2) | ((c2 & 0xc0) >> 4) | ((c1 & 0xc0) >> 6), c3 & 0x3f, c2 & 0x3f, c1 & 0x3f];
}

/**
 * The 524 bytes of a sector as 699 six-bit values, followed by the 4 of its
 * checksum. Three running checksums are kept; each byte is stored exclusive-ored
 * with one of them, and the first is rotated left every three bytes.
 */
export function encodeSector(data: Uint8Array): number[] {
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  const out: number[] = [];
  const group = (a: number, b: number, c: number | null) => {
    out.push(((a & 0xc0) >> 2) | ((b & 0xc0) >> 4) | (((c ?? 0) & 0xc0) >> 6), a & 0x3f, b & 0x3f);
    if (c !== null) out.push(c & 0x3f);
  };
  for (let i = 0; i < SECTOR_BYTES; ) {
    c1 = (c1 & 0xff) << 1;
    if (c1 & 0x100) c1++;
    const d1 = data[i++];
    c3 += d1 + (c1 >> 8);
    const e1 = d1 ^ (c1 & 0xff);
    const d2 = data[i++];
    const e2 = d2 ^ (c3 & 0xff);
    c2 += d2 + (c3 >> 8);
    c3 &= 0xff;
    if (i === SECTOR_BYTES) {
      group(e1, e2, null);
      break;
    }
    const d3 = data[i++];
    const e3 = d3 ^ (c2 & 0xff);
    c1 += d3 + (c2 >> 8);
    c2 &= 0xff;
    group(e1, e2, e3);
  }
  out.push(...checksumValues(c1, c2, c3));
  return out;
}

/** The 524 bytes of a sector from its 699 + 4 six-bit values, or null if the checksum is wrong. */
export function decodeSector(values: ArrayLike<number>): Uint8Array | null {
  const data = new Uint8Array(SECTOR_BYTES);
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  let at = 0;
  const unpack = (count: number) => {
    const high = values[at];
    const bytes = [((high << 2) & 0xc0) | values[at + 1], ((high << 4) & 0xc0) | values[at + 2]];
    if (count === 3) bytes.push(((high << 6) & 0xc0) | values[at + 3]);
    at += count + 1;
    return bytes;
  };
  for (let i = 0; i < SECTOR_BYTES; ) {
    const [e1, e2, e3] = unpack(i + 2 === SECTOR_BYTES ? 2 : 3);
    c1 = (c1 & 0xff) << 1;
    if (c1 & 0x100) c1++;
    const d1 = e1 ^ (c1 & 0xff);
    c3 += d1 + (c1 >> 8);
    data[i++] = d1;
    const d2 = e2 ^ (c3 & 0xff);
    c2 += d2 + (c3 >> 8);
    c3 &= 0xff;
    data[i++] = d2;
    if (i === SECTOR_BYTES) break;
    const d3 = e3 ^ (c2 & 0xff);
    c1 += d3 + (c2 >> 8);
    c2 &= 0xff;
    data[i++] = d3;
  }
  const expected = checksumValues(c1 & 0xff, c2 & 0xff, c3 & 0xff);
  return expected.every((value, i) => values[at + i] === value) ? data : null;
}

/** A track of an 800K disk as bits: each sector an address field and a data field, between self-sync gaps. */
export function buildTrack35(cylinder: number, side: number, sectorData: (sector: number) => Uint8Array): Uint8Array {
  const out = new NibbleWriter();
  const sectors = sectorsOnCylinder(cylinder);
  const sideByte = (side << 5) | (cylinder >> 6);
  const gcr = (value: number) => out.byte(WRITE_TABLE[value & 0x3f]);
  out.sync(64);
  for (const sector of interleave(sectors)) {
    out.byte(0xd5);
    out.byte(0xaa);
    out.byte(0x96);
    for (const value of [cylinder & 0x3f, sector, sideByte, FORMAT_800K]) gcr(value);
    gcr((cylinder ^ sector ^ sideByte ^ FORMAT_800K) & 0x3f);
    out.byte(0xde);
    out.byte(0xaa);
    out.sync(6);
    out.byte(0xd5);
    out.byte(0xaa);
    out.byte(0xad);
    gcr(sector);
    for (const value of encodeSector(sectorData(sector))) gcr(value);
    out.byte(0xde);
    out.byte(0xaa);
    out.sync(36);
  }
  const bits = out.toBits();
  const length = ZONE_TRACK_BITS[cylinder >> 4];
  if (bits.length >= length) return bits;
  // The rest of the track is self-sync bytes (1111111100), as the formatter leaves it.
  const track = new Uint8Array(length);
  track.set(bits);
  for (let at = bits.length; at < length; at++) track[at] = (at - bits.length) % 10 < 8 ? 1 : 0;
  return track;
}

/** The sectors found on a track, by sector number (each 524 bytes with its tags). */
export function readSectors35(bits: Uint8Array): Map<number, Uint8Array> {
  const nibbles = trackNibbles(bits);
  const sectors = new Map<number, Uint8Array>();
  const value = (at: number) => READ_TABLE[nibbles[at]];
  for (let i = 0; i + 10 < nibbles.length; i++) {
    if (nibbles[i] !== 0xd5 || nibbles[i + 1] !== 0xaa || nibbles[i + 2] !== 0x96) continue;
    const sector = value(i + 4);
    for (let j = i + 10; j < i + 40 && j + 4 + ENCODED_BYTES + 4 <= nibbles.length; j++) {
      if (nibbles[j] !== 0xd5 || nibbles[j + 1] !== 0xaa || nibbles[j + 2] !== 0xad) continue;
      const values = Array.from(nibbles.subarray(j + 4, j + 4 + ENCODED_BYTES + 4), (nibble) => READ_TABLE[nibble]);
      const data = values.includes(-1) ? null : decodeSector(values);
      if (data && sector >= 0 && !sectors.has(sector)) sectors.set(sector, data);
      break;
    }
  }
  return sectors;
}

/** An 800K image's blocks: a ProDOS-ordered image (.po, .hdv) or a 2IMG file's. */
function imageBlocks(name: string, data: Uint8Array): Uint8Array {
  if (String.fromCharCode(...data.subarray(0, 4)) === TWO_IMG_MAGIC) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const offset = view.getUint32(0x18, true) || TWO_IMG_HEADER;
    const length = view.getUint32(0x1c, true) || data.length - offset;
    return data.subarray(offset, offset + length);
  }
  if (data.length !== DISK35_BYTES) {
    throw new Error(`${name} is ${data.length.toLocaleString('en')} bytes, which isn't an 800K disk image (819,200 bytes, or a .2mg).`);
  }
  return data;
}

/**
 * A 3.5" 800K disk as the drive sees it: for each side of each cylinder, a
 * track of bits in Apple's GCR format, made from a ProDOS-ordered image
 * (.po or .2mg). Changes are written into the tracks and read back into
 * blocks when the image is saved.
 */
export class Disk35 {
  dirty = false;

  private constructor(
    readonly name: string,
    /** By cylinder * 2 + side. */
    readonly tracks: Uint8Array[],
    public writeProtected: boolean,
    private readonly original: Uint8Array,
  ) {}

  static isDiskSize(size: number): boolean {
    return size === DISK35_BYTES;
  }

  /** An empty disk: every block zero, for initializing from GS/OS or ProDOS. */
  static blank(name: string): Disk35 {
    return Disk35.fromImage(name, new Uint8Array(DISK35_BYTES));
  }

  /** The file extension the disk saves as. */
  get extension(): string {
    return '.po';
  }

  /** Whether every sector still reads back (it would not after a copy-protected reformat). */
  get savesCompletely(): boolean {
    return this.tracks.every((bits, i) => readSectors35(bits).size === sectorsOnCylinder(i >> 1));
  }

  static fromImage(name: string, data: Uint8Array): Disk35 {
    const blocks = imageBlocks(name, data);
    if (blocks.length !== DISK35_BYTES) throw new Error(`${name} isn't an 800K disk.`);
    const tracks: Uint8Array[] = [];
    for (let cylinder = 0; cylinder < CYLINDERS; cylinder++) {
      for (let side = 0; side < SIDES; side++) {
        const first = firstBlock(cylinder, side);
        tracks.push(
          buildTrack35(cylinder, side, (sector) => {
            const sectorData = new Uint8Array(SECTOR_BYTES);
            sectorData.set(blocks.subarray((first + sector) * BLOCK_BYTES, (first + sector + 1) * BLOCK_BYTES), TAG_BYTES);
            return sectorData;
          }),
        );
      }
    }
    return new Disk35(name, tracks, false, blocks.slice());
  }

  track(cylinder: number, side: number): Uint8Array {
    return this.tracks[cylinder * SIDES + side];
  }

  /** The disk as a ProDOS-ordered image, with what has been written to it. */
  toImage(): Uint8Array {
    const out = this.original.slice();
    for (let cylinder = 0; cylinder < CYLINDERS; cylinder++) {
      for (let side = 0; side < SIDES; side++) {
        const first = firstBlock(cylinder, side);
        for (const [sector, data] of readSectors35(this.track(cylinder, side))) {
          if (sector < sectorsOnCylinder(cylinder)) out.set(data.subarray(TAG_BYTES), (first + sector) * BLOCK_BYTES);
        }
      }
    }
    return out;
  }
}
