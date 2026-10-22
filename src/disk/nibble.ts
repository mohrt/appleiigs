/**
 * The 16-sector format DOS 3.3 and ProDOS write: each sector is an address
 * field and a data field of "6-and-2" nibbles (disk bytes with the top bit set
 * and no two zero bits in a row), separated by self-sync bytes.
 */

export const TRACKS = 35;
export const SECTORS = 16;
export const SECTOR_BYTES = 256;
export const TRACK_BYTES = SECTORS * SECTOR_BYTES;
export const DISK_BYTES = TRACKS * TRACK_BYTES;
export const DEFAULT_VOLUME = 254;

/** 6-bit values to disk bytes. */
const WRITE_TABLE = [
  0x96, 0x97, 0x9a, 0x9b, 0x9d, 0x9e, 0x9f, 0xa6, 0xa7, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xcb, 0xcd, 0xce, 0xcf, 0xd3,
  0xd6, 0xd7, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe5, 0xe6, 0xe7, 0xe9, 0xea, 0xeb, 0xec,
  0xed, 0xee, 0xef, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
];
const READ_TABLE = new Int8Array(256).fill(-1);
WRITE_TABLE.forEach((nibble, value) => (READ_TABLE[nibble] = value));

/** Where each physical sector's data lives in a DOS-ordered image (.dsk, .do). */
export const DOS_ORDER = [0, 7, 14, 6, 13, 5, 12, 4, 11, 3, 10, 2, 9, 1, 8, 15];
/** And in a ProDOS-ordered image (.po). */
export const PRODOS_ORDER = [0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];

/** Disk bytes, each with the number of bits it takes on the track (10 for a self-sync $FF). */
export class NibbleWriter {
  private readonly bytes: number[] = [];
  private readonly widths: number[] = [];

  byte(value: number): void {
    this.bytes.push(value);
    this.widths.push(8);
  }

  sync(count: number): void {
    for (let i = 0; i < count; i++) {
      this.bytes.push(0xff);
      this.widths.push(10);
    }
  }

  /** A value as two "4-and-4" disk bytes, as in address fields. */
  fourAndFour(value: number): void {
    this.byte((value >> 1) | 0xaa);
    this.byte(value | 0xaa);
  }

  /** One bit per byte, as tracks are kept. */
  toBits(): Uint8Array {
    const total = this.widths.reduce((sum, width) => sum + width, 0);
    const bits = new Uint8Array(total);
    let at = 0;
    this.bytes.forEach((value, i) => {
      for (let bit = 7; bit >= 0; bit--) bits[at++] = (value >> bit) & 1;
      at += this.widths[i] - 8;
    });
    return bits;
  }
}

/** 256 data bytes as the 343 disk bytes of a data field (342 values and a checksum). */
export function encode62(data: Uint8Array): number[] {
  const values = new Uint8Array(0x158);
  let index2 = 0x55;
  for (let index6 = 0x101; index6 >= 0; index6--) {
    let value6 = data[index6 & 0xff];
    let value2 = values[index2];
    value2 = (value2 << 1) | (value6 & 1);
    value6 >>= 1;
    value2 = (value2 << 1) | (value6 & 1);
    value6 >>= 1;
    values[index2] = value2 & 0x3f;
    if (index6 < 0x100) values[0x56 + index6] = value6;
    if (--index2 < 0) index2 = 0x55;
  }
  const out: number[] = [];
  let last = 0;
  for (let i = 0; i < 0x156; i++) {
    out.push(WRITE_TABLE[last ^ values[i]]);
    last = values[i];
  }
  out.push(WRITE_TABLE[last]);
  return out;
}

/** The 256 bytes of a data field's 343 disk bytes, or null if they don't decode or the checksum is wrong. */
export function decode62(nibbles: ArrayLike<number>): Uint8Array | null {
  const values = new Uint8Array(0x156);
  let last = 0;
  for (let i = 0; i < 0x156; i++) {
    const value = READ_TABLE[nibbles[i]];
    if (value < 0) return null;
    last ^= value;
    values[i] = last;
  }
  if (READ_TABLE[nibbles[0x156]] !== last) return null;
  const data = new Uint8Array(SECTOR_BYTES);
  for (let i = 0; i < SECTOR_BYTES; i++) {
    const pair = (values[i % 0x56] >> (2 * Math.floor(i / 0x56))) & 3;
    data[i] = (values[0x56 + i] << 2) | ((pair & 1) << 1) | (pair >> 1);
  }
  return data;
}

/** A track of 16 sectors, as DOS 3.3's INIT lays it out, as bits. */
export function buildTrack(track: number, sectorData: (physical: number) => Uint8Array, volume = DEFAULT_VOLUME): Uint8Array {
  const out = new NibbleWriter();
  out.sync(48);
  for (let sector = 0; sector < SECTORS; sector++) {
    out.byte(0xd5);
    out.byte(0xaa);
    out.byte(0x96);
    out.fourAndFour(volume);
    out.fourAndFour(track);
    out.fourAndFour(sector);
    out.fourAndFour(volume ^ track ^ sector);
    out.byte(0xde);
    out.byte(0xaa);
    out.byte(0xeb);
    out.sync(6);
    out.byte(0xd5);
    out.byte(0xaa);
    out.byte(0xad);
    for (const nibble of encode62(sectorData(sector))) out.byte(nibble);
    out.byte(0xde);
    out.byte(0xaa);
    out.byte(0xeb);
    // Gaps that make the track about 51,100 bits, what a drive turning at 300 rpm holds at 4 µs a bit.
    out.sync(20);
  }
  return out.toBits();
}

/**
 * The disk bytes a drive would read from a track: bits shifted into a latch,
 * which starts a byte at the first 1 bit. Read round the track twice, so a
 * field that wraps past the end is complete.
 */
export function trackNibbles(bits: Uint8Array, bitCount = bits.length): Uint8Array {
  const out: number[] = [];
  let latch = 0;
  for (let i = 0; i < bitCount * 2; i++) {
    const bit = bits[i % bitCount];
    if (latch === 0 && bit === 0) continue;
    latch = (latch << 1) | bit;
    if (latch & 0x80) {
      out.push(latch);
      latch = 0;
    }
  }
  return Uint8Array.from(out);
}

const fourAndFour = (a: number, b: number) => ((a << 1) | 1) & b;

/** The 16-sector sectors found on a track, by physical sector number. */
export function readSectors(bits: Uint8Array, bitCount = bits.length): Map<number, Uint8Array> {
  const nibbles = trackNibbles(bits, bitCount);
  const sectors = new Map<number, Uint8Array>();
  for (let i = 0; i + 14 < nibbles.length; i++) {
    if (nibbles[i] !== 0xd5 || nibbles[i + 1] !== 0xaa || nibbles[i + 2] !== 0x96) continue;
    const sector = fourAndFour(nibbles[i + 7], nibbles[i + 8]);
    // The data field follows within a few dozen bytes.
    for (let j = i + 11; j < i + 60 && j + 3 + 0x157 <= nibbles.length; j++) {
      if (nibbles[j] !== 0xd5 || nibbles[j + 1] !== 0xaa || nibbles[j + 2] !== 0xad) continue;
      const data = decode62(nibbles.subarray(j + 3, j + 3 + 0x157));
      if (data && sector < SECTORS && !sectors.has(sector)) sectors.set(sector, data);
      break;
    }
    if (sectors.size === SECTORS) break;
  }
  return sectors;
}
