import { describe, expect, it } from 'vitest';
import { CLOCK_HZ, Iigs } from '../src/iigs';
import { ROM_FILES, bootMachine, haveRom, screenText } from './helpers/machine';

/** A blank ROM 3 whose code at $FF:F000 loops, which is enough to drive the bus by hand. */
function testMachine(): Iigs {
  const main = new Uint8Array(0x40000);
  const bankFF = main.length - 0x10000;
  main[bankFF + 0xfffc] = 0x00;
  main[bankFF + 0xfffd] = 0xf0;
  main.set([0x4c, 0x00, 0xf0], bankFF + 0xf000);
  main[bankFF + 0xc600] = 0xa2;
  return new Iigs({ main, video: new Uint8Array(0x1000) });
}

describe('memory map', () => {
  it('shadows the text page to bank $E0 unless $C035 says not to', () => {
    const gs = testMachine();
    gs.write(0x000400, 0xc1);
    expect(gs.slowRam[0x0400]).toBe(0xc1);
    gs.write(0x00c035, 0x01);
    gs.write(0x000400, 0xc2);
    expect(gs.read(0x000400)).toBe(0xc2);
    expect(gs.slowRam[0x0400]).toBe(0xc1);
  });

  it('sends bank $00 writes to bank $01 with RAMWRT, shadowed to $E1', () => {
    const gs = testMachine();
    gs.write(0x00c005, 0);
    gs.write(0x002000, 0x55);
    expect(gs.ram[0x012000]).toBe(0x55);
    expect(gs.ram[0x002000]).toBe(0);
    expect(gs.slowRam[0x012000]).toBe(0x55);
  });

  it('shadows Super Hi-Res in bank $01 only while $C035 bit 3 is clear', () => {
    const gs = testMachine();
    gs.write(0x00c035, 0x08);
    gs.write(0x016000, 0x11);
    expect(gs.slowRam[0x016000]).toBe(0);
    gs.write(0x00c035, 0x00);
    gs.write(0x016000, 0x22);
    expect(gs.slowRam[0x016000]).toBe(0x22);
    gs.write(0x006000, 0x33);
    expect(gs.slowRam[0x006000]).toBe(0);
  });

  it('reads the ROM through the language card, and its RAM after two reads of $C083', () => {
    const gs = testMachine();
    expect(gs.read(0x00fffd)).toBe(0xf0);
    gs.read(0x00c083);
    gs.read(0x00c083);
    gs.write(0x00d000, 0x77);
    expect(gs.read(0x00d000)).toBe(0x77);
    gs.read(0x00c082);
    expect(gs.read(0x00d000)).toBe(0);
  });

  it('shows the internal slot firmware, and RAM at $C000 with I/O inhibited', () => {
    const gs = testMachine();
    expect(gs.read(0x00c600)).toBe(0xa2);
    gs.write(0x00c035, 0x40);
    gs.write(0x00c600, 0x99);
    expect(gs.read(0x00c600)).toBe(0x99);
  });
});

describe('clock', () => {
  it('reads back battery RAM written through $C033 and $C034', () => {
    const gs = testMachine();
    const transfer = (data: number | null) => {
      if (data !== null) gs.write(0x00c033, data);
      gs.write(0x00c034, data === null ? 0xe0 : 0xa0);
      return gs.read(0x00c033);
    };
    // Extended command for address $5A: z0111abc (abc = 010), then defgh00 (defgh = 11010).
    transfer(0x38 | 0x02);
    transfer(0x1a << 2);
    transfer(0x6b);
    transfer(0x80 | 0x38 | 0x02);
    transfer(0x1a << 2);
    expect(transfer(null)).toBe(0x6b);
    expect(gs.clock.bram[0x5a]).toBe(0x6b);
  });
});

describe.each(Object.entries(ROM_FILES))('%s', (_, file) => {
  it.skipIf(!haveRom(file))('reaches "Check startup device!" with no disks', () => {
    const gs = bootMachine(file);
    gs.runCycles(Math.round(CLOCK_HZ * 12));
    expect(screenText(gs).join('\n')).toContain('Check startup device!');
  });
});
