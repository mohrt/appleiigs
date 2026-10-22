import { describe, expect, it } from 'vitest';
import { BLOCK_BYTES, DISK35_BYTES, Disk35 } from '../src/disk/disk35';
import { CLOCK_HZ, Iigs } from '../src/iigs';
import { COPY_BLOCK, ROM_FILES, bootMachine, bootTestDisk, haveRom, screenText } from './helpers/machine';

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

describe('sound', () => {
  it('plays an Ensoniq oscillator set up through the sound GLU, and interrupts the CPU when it ends', () => {
    const gs = testMachine();
    gs.audio.setRates(CLOCK_HZ, 48_000);
    const glu = (reg: number, value: number) => gs.write(0x00c000 | reg, value);
    // A 256-byte square wave at $2000 in sound RAM, written with auto-increment.
    glu(0x3c, 0x60 | 0x0f);
    glu(0x3e, 0x00);
    glu(0x3f, 0x20);
    for (let i = 0; i < 256; i++) glu(0x3d, i < 128 ? 0x40 : 0xc0);
    // Oscillator 0: that table, full volume, one-shot with its interrupt; one oscillator enabled.
    glu(0x3c, 0x20 | 0x0f);
    const doc = (register: number, value: number) => {
      glu(0x3e, register);
      glu(0x3d, value);
    };
    doc(0xe1, 0x00);
    doc(0x80, 0x20);
    doc(0xc0, 0x00);
    doc(0x40, 0xff);
    doc(0x20, 0x01);
    doc(0xa0, 0x02 | 0x08);
    gs.runCycles(CLOCK_HZ / 20);
    const samples = gs.audio.takeSamples();
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.1);
    expect(gs.sound.doc.irq).toBe(true);
  });
});

describe('800K disks', () => {
  it('turn blocks into GCR tracks and back', () => {
    const image = new Uint8Array(DISK35_BYTES);
    for (let i = 0; i < image.length; i++) image[i] = (i * 7 + (i >> 9)) & 0xff;
    const disk = Disk35.fromImage('test.po', image);
    expect(disk.toImage()).toEqual(image);
  });
});

describe.each(Object.entries(ROM_FILES))('%s', (_, file) => {
  it.skipIf(!haveRom(file))('reaches "Check startup device!" with no disks', () => {
    const gs = bootMachine(file);
    gs.runCycles(Math.round(CLOCK_HZ * 12));
    expect(screenText(gs).join('\n')).toContain('Check startup device!');
  });

  it.skipIf(!haveRom(file))('boots an 800K disk, which reads and writes blocks through the firmware', () => {
    const gs = bootMachine(file);
    const disk = bootTestDisk();
    gs.insertDisk35(0, disk);
    gs.powerOn();
    gs.runCycles(Math.round(CLOCK_HZ * 10));
    expect([gs.ram[0x0301], gs.ram[0x0300], gs.ram[0x0302], gs.ram[0x0303]]).toEqual([0xa5, 0, 0, 0]);
    expect(String.fromCharCode(...gs.ram.subarray(0x2000, 0x2004))).toBe('LAST');
    expect(String.fromCharCode(...gs.ram.subarray(0x3000, 0x3004))).toBe('LAST');
    expect(disk.dirty).toBe(true);
    const saved = disk.toImage().subarray(COPY_BLOCK * BLOCK_BYTES, COPY_BLOCK * BLOCK_BYTES + 4);
    expect(String.fromCharCode(...saved)).toBe('LAST');
  });
});
