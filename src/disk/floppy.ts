import {
  DISK_BYTES,
  DOS_ORDER,
  PRODOS_ORDER,
  SECTOR_BYTES,
  TRACKS,
  TRACK_BYTES,
  NibbleWriter,
  buildTrack,
  readSectors,
  trackNibbles,
} from './nibble';
import { buildWoz, isWoz, parseWoz } from './woz';

/** How a disk image file lays out the disk, and so how it is saved back. */
export type DiskFormat = 'dos' | 'prodos' | 'nib' | 'woz';

export const NIB_TRACK_BYTES = 6656;
const NIB_BYTES = TRACKS * NIB_TRACK_BYTES;
const QUARTER_TRACKS = 160;
/** A run of this many $FF bytes in a .nib is taken to be self-sync bytes. */
const NIB_SYNC_RUN = 4;

/** A DOS 3.3 VTOC on track 17, sector 0 of a DOS-ordered image. */
function hasDosCatalog(data: Uint8Array): boolean {
  const vtoc = 17 * TRACK_BYTES;
  return data[vtoc + 1] === 17 && data[vtoc + 0x27] === 122 && data[vtoc + 0x34] === TRACKS && data[vtoc + 0x35] === 16;
}

/** A ProDOS volume directory header in block 2 of a ProDOS-ordered image. */
function hasProdosDirectory(data: Uint8Array): boolean {
  const block = 2 * 512;
  return data[block] === 0 && data[block + 1] === 0 && data[block + 4] >> 4 === 0xf && (data[block + 4] & 0x0f) > 0;
}

/** Whether a 140K image is in ProDOS order: by its extension, or else by finding a ProDOS directory and no DOS one. */
export function isProdosOrder(name: string, data: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.po')) return true;
  if (lower.endsWith('.do')) return false;
  return !hasDosCatalog(data) && hasProdosDirectory(data);
}

/** .nib tracks as bits, turning runs of $FF into 10-bit self-sync bytes. */
function nibTrackBits(nibbles: Uint8Array): Uint8Array {
  const out = new NibbleWriter();
  for (let i = 0; i < nibbles.length; ) {
    let run = 0;
    while (i + run < nibbles.length && nibbles[i + run] === 0xff) run++;
    if (run >= NIB_SYNC_RUN) {
      out.sync(run);
      i += run;
    } else {
      out.byte(nibbles[i++]);
    }
  }
  return out.toBits();
}

/** Standard 35-track disks use each track at its own quarter-track position and the ones either side. */
function standardQuarterTracks(): Int16Array {
  const map = new Int16Array(QUARTER_TRACKS).fill(-1);
  for (let track = 0; track < TRACKS; track++) {
    for (const quarter of [track * 4 - 1, track * 4, track * 4 + 1]) if (quarter >= 0) map[quarter] = track;
  }
  return map;
}

/**
 * A 5.25" floppy as the Disk II sees it: a stream of bits for each track, at
 * quarter-track positions. Sector images (.dsk, .do, .po) and .nib images are
 * turned into tracks as DOS 3.3 formats them; WOZ images keep their own,
 * copy protection included. Changes are written into the tracks and turned
 * back into the image's own format when saved.
 */
export class FloppyDisk {
  /** Set when the drive writes to the disk. */
  dirty = false;

  private constructor(
    readonly name: string,
    readonly format: DiskFormat,
    /** For each quarter-track position, the index of its track in `tracks`, or -1 for none. */
    readonly quarterTracks: Int16Array,
    /** Each track's bits, one per byte. */
    readonly tracks: Uint8Array[],
    public writeProtected: boolean,
    /** Bit cell width in 125 ns units (32 is 4 µs). */
    readonly bitTiming: number,
    /** The image as it was loaded, for sectors that no longer decode when saving. */
    private readonly original: Uint8Array,
    private readonly wozExtras: { info: Uint8Array; meta: Uint8Array | null } | null = null,
  ) {}

  static isDiskSize(size: number): boolean {
    return size === DISK_BYTES || size === NIB_BYTES;
  }

  /** Reads a .dsk, .do, .po, .nib or .woz image. */
  static fromImage(name: string, data: Uint8Array): FloppyDisk {
    if (isWoz(data)) {
      const woz = parseWoz(data);
      return new FloppyDisk(name, 'woz', woz.quarterTracks, woz.tracks.map((track) => track.bits), woz.writeProtected, woz.bitTiming, data.slice(), {
        info: woz.info,
        meta: woz.meta,
      });
    }
    if (data.length === NIB_BYTES) {
      const tracks = Array.from({ length: TRACKS }, (_, t) => nibTrackBits(data.subarray(t * NIB_TRACK_BYTES, (t + 1) * NIB_TRACK_BYTES)));
      return new FloppyDisk(name, 'nib', standardQuarterTracks(), tracks, false, 32, data.slice());
    }
    if (data.length !== DISK_BYTES) {
      throw new Error(
        `${name} is ${data.length.toLocaleString('en')} bytes, which isn't an Apple II floppy image. ` +
          'Sector images (.dsk, .do, .po) are 143,360 bytes and .nib images 232,960.',
      );
    }
    const format: DiskFormat = isProdosOrder(name, data) ? 'prodos' : 'dos';
    const order = format === 'prodos' ? PRODOS_ORDER : DOS_ORDER;
    const tracks = Array.from({ length: TRACKS }, (_, track) =>
      buildTrack(track, (physical) => {
        const at = track * TRACK_BYTES + order[physical] * SECTOR_BYTES;
        return data.subarray(at, at + SECTOR_BYTES);
      }),
    );
    return new FloppyDisk(name, format, standardQuarterTracks(), tracks, false, 32, data.slice());
  }

  /** A disk from a save state: its exact tracks (as WOZ), saved later in its own format. */
  static restore(name: string, format: DiskFormat, woz: Uint8Array): FloppyDisk {
    const parsed = parseWoz(woz);
    const original = format === 'woz' ? woz.slice() : new Uint8Array(format === 'nib' ? NIB_BYTES : DISK_BYTES);
    return new FloppyDisk(name, format, parsed.quarterTracks, parsed.tracks.map((track) => track.bits), parsed.writeProtected, parsed.bitTiming, original, {
      info: parsed.info,
      meta: parsed.meta,
    });
  }

  /** The tracks exactly as they are, as a WOZ image (for save states). */
  toWoz(): Uint8Array {
    return buildWoz({
      quarterTracks: this.quarterTracks,
      tracks: this.tracks.map((bits) => ({ bits })),
      writeProtected: this.writeProtected,
      bitTiming: this.bitTiming,
      info: this.wozExtras?.info ?? new Uint8Array(60),
      meta: this.wozExtras?.meta ?? null,
    });
  }

  /** An empty disk (no tracks written yet), for formatting from DOS or ProDOS. */
  static blank(name: string): FloppyDisk {
    const tracks = Array.from({ length: TRACKS }, () => new Uint8Array(51200));
    return new FloppyDisk(name, 'dos', standardQuarterTracks(), tracks, false, 32, new Uint8Array(DISK_BYTES));
  }

  /** The track under the head at a quarter-track position, or null where there is none. */
  trackAt(quarterTrack: number): Uint8Array | null {
    const index = this.quarterTracks[quarterTrack] ?? -1;
    return index >= 0 ? this.tracks[index] : null;
  }

  /** The file extension the disk saves as. */
  get extension(): string {
    return { dos: '.dsk', prodos: '.po', nib: '.nib', woz: '.woz' }[this.format];
  }

  /** The disk as an image in its own format, with what has been written to it. */
  toImage(): Uint8Array {
    switch (this.format) {
      case 'woz':
        return this.toWoz();
      case 'nib': {
        const out = new Uint8Array(NIB_BYTES);
        this.tracks.forEach((bits, track) => {
          const nibbles = trackNibbles(bits).subarray(0, NIB_TRACK_BYTES);
          out.fill(0xff, track * NIB_TRACK_BYTES, (track + 1) * NIB_TRACK_BYTES);
          out.set(nibbles, track * NIB_TRACK_BYTES);
        });
        return out;
      }
      default: {
        const out = this.original.slice();
        const order = this.format === 'prodos' ? PRODOS_ORDER : DOS_ORDER;
        this.tracks.forEach((bits, track) => {
          for (const [physical, data] of readSectors(bits)) out.set(data, track * TRACK_BYTES + order[physical] * SECTOR_BYTES);
        });
        return out;
      }
    }
  }

  /** Whether every sector of a sector image still reads back (a disk reformatted with copy protection wouldn't). */
  get savesCompletely(): boolean {
    if (this.format === 'woz' || this.format === 'nib') return true;
    return this.tracks.every((bits) => readSectors(bits).size === 16);
  }
}
