import { romVersionOf, type Roms } from '../iigs';
import type { KeyValueStore } from '../storage/store';
import { crc32 } from '../util/crc32';

/** The IIgs's two ROMs: ROM 01 (1987) and ROM 3 (1989). */
export type Model = 'rom01' | 'rom3';
/** The ROMs kept: either main ROM, and the character ROM both use. */
export type RomKind = Model | 'video';
export const ROM_KINDS: readonly RomKind[] = ['rom01', 'rom3', 'video'];
export const MODEL_ROMS: Record<Model, readonly RomKind[]> = { rom01: ['rom01', 'video'], rom3: ['rom3', 'video'] };
export const MODEL_NAMES: Record<Model, string> = { rom01: 'Apple IIgs (ROM 01)', rom3: 'Apple IIgs (ROM 3)' };

const BANK_SIZE = 0x10000;
const ROM01_SIZE = 0x20000;
const ROM3_SIZE = 0x40000;
const VIDEO_SIZE = 0x1000;
export const ROM_FILE_SIZES = new Set([ROM01_SIZE, ROM3_SIZE, VIDEO_SIZE]);

/** CRC-32s of Apple's ROMs, each bank from the lowest ($FC or $FE) up. */
const KNOWN_BANKS: Record<Model, number[]> = {
  rom01: [0xcb0225a9, 0xd0ecc6f3],
  rom3: [0x73a65155, 0x5aa5b8f0, 0x096738dc, 0x35054969],
};
const KNOWN_VIDEO = 0x91e53cd8;

export interface StoredRom {
  /** The file it came from, shown to the user. */
  name: string;
  data: Uint8Array;
}

export interface IdentifiedRom extends StoredRom {
  kind: RomKind;
  /** Set when the file is the right size but not one of Apple's ROMs. */
  warning: string | null;
}

export type SystemRoms = Partial<Record<RomKind, StoredRom>>;

/** Files of other sizes in a collection that are skipped quietly rather than reported. */
export class NotARom extends Error {}

const baseName = (name: string) => name.split('/').pop()!;

/**
 * Apple's ROM with its banks in order ($FC or $FE first), or null if the
 * banks aren't all Apple's. Some dumps have a chip's two banks the other way round.
 */
function inBankOrder(data: Uint8Array, model: Model): Uint8Array | null {
  const known = KNOWN_BANKS[model];
  const banks = Array.from({ length: data.length / BANK_SIZE }, (_, i) => data.subarray(i * BANK_SIZE, (i + 1) * BANK_SIZE));
  const crcs = banks.map(crc32);
  if (!crcs.every((crc) => known.includes(crc))) return null;
  const ordered = new Uint8Array(data.length);
  banks.forEach((bank, i) => ordered.set(bank, known.indexOf(crcs[i]) * BANK_SIZE));
  return ordered;
}

/** The 65816's reset vector, at the end of the last bank, points into the ROM's $Fxxx code. */
function hasResetVector(data: Uint8Array): boolean {
  const vector = data[data.length - 4] | (data[data.length - 3] << 8);
  return vector >= 0xf000;
}

/** Works out which ROM a file is (putting a dump's banks in order); throws if it can't be one. */
export function identifyRom(name: string, data: Uint8Array): IdentifiedRom {
  const unknown = "not one of Apple's ROMs; some software may not work with it";
  switch (data.length) {
    case ROM01_SIZE:
    case ROM3_SIZE: {
      const kind: Model = data.length === ROM3_SIZE ? 'rom3' : 'rom01';
      const ordered = inBankOrder(data, kind);
      if (ordered) return { kind, name, data: ordered, warning: null };
      if (!hasResetVector(data)) throw new Error(`${baseName(name)} is the size of an Apple IIgs ROM but doesn't start like one.`);
      return { kind, name, data, warning: unknown };
    }
    case VIDEO_SIZE:
      return { kind: 'video', name, data, warning: crc32(data) === KNOWN_VIDEO ? null : unknown };
    default:
      throw new NotARom(
        `${baseName(name)} is ${data.length.toLocaleString('en')} bytes, which isn't an Apple IIgs ROM. ` +
          'ROM 01 is 131,072 bytes, ROM 3 262,144, and the character ROM 4,096.',
      );
  }
}

export function hasRom(roms: SystemRoms, kind: RomKind): boolean {
  return roms[kind] !== undefined;
}

export function hasRequiredRoms(roms: SystemRoms, model: Model): boolean {
  return MODEL_ROMS[model].every((kind) => hasRom(roms, kind));
}

/** The ROMs a model maps in; throws if any is missing. */
export function machineRoms(roms: SystemRoms, model: Model): Roms {
  if (!hasRequiredRoms(roms, model)) throw new Error(`The ${MODEL_NAMES[model]} needs its ROMs: load them in Machine setup.`);
  return { main: roms[model]!.data, video: roms.video!.data };
}

export function modelName(roms: Roms): string {
  return romVersionOf(roms.main) >= 3 ? MODEL_NAMES.rom3 : MODEL_NAMES.rom01;
}

/** The CRC-32 of the ROMs a state was saved with: states only make sense with the same ones. */
export function romsCrc(roms: Roms): number {
  const all = new Uint8Array(roms.main.length + roms.video.length);
  all.set(roms.main);
  all.set(roms.video, roms.main.length);
  return crc32(all);
}

/**
 * The user's ROMs, kept in browser storage (IndexedDB) so they only have to be
 * given once. Saving asks the browser to make the storage persistent, which
 * stops it evicting the ROMs under storage pressure.
 */
export class SystemRomStore {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  async load(): Promise<SystemRoms> {
    const roms: SystemRoms = {};
    for (const [key, rom] of await this.store.entries()) {
      if (ROM_KINDS.includes(key as RomKind)) roms[key as RomKind] = rom;
    }
    return roms;
  }

  async save(kind: RomKind, rom: StoredRom): Promise<void> {
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    await this.store.put(kind, { name: rom.name, data: rom.data });
  }

  async forget(): Promise<void> {
    await Promise.all(ROM_KINDS.map((kind) => this.store.delete(kind)));
  }
}
