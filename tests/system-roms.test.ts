import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyRom } from '../src/roms/system-roms';
import { ROM_FILES, haveRom, romDir } from './helpers/machine';

describe('identifying ROMs', () => {
  it('rejects files of other sizes', () => {
    expect(() => identifyRom('kick.rom', new Uint8Array(0x80000))).toThrow(/isn't an Apple IIgs ROM/);
  });

  it.skipIf(!haveRom(ROM_FILES.rom01))('puts a dump with its banks swapped back in order', () => {
    const rom = new Uint8Array(readFileSync(join(romDir, ROM_FILES.rom01)));
    const swapped = new Uint8Array(rom.length);
    swapped.set(rom.subarray(0x10000), 0);
    swapped.set(rom.subarray(0, 0x10000), 0x10000);
    const identified = identifyRom('342-0077-b.bin', swapped);
    expect(identified.kind).toBe('rom01');
    expect(identified.warning).toBeNull();
    expect(identified.data).toEqual(rom);
  });

  it.skipIf(!haveRom(ROM_FILES.rom3))('knows ROM 3 and the character ROM', () => {
    expect(identifyRom('apple2gs.rom', new Uint8Array(readFileSync(join(romDir, ROM_FILES.rom3)))).kind).toBe('rom3');
    expect(identifyRom('apple2gs.chr', new Uint8Array(readFileSync(join(romDir, 'apple2gs.chr')))).warning).toBeNull();
  });
});
