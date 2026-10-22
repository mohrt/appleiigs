import { describe, expect, it } from 'vitest';
import { Doc5503 } from '../src/sound/doc5503';

const MEGA_HZ = 1_020_484;

/** A DOC with a 256-byte table of mid-high samples at $1000 and oscillator 0 set to play it. */
function setUp(control: number): { doc: Doc5503; ram: Uint8Array; levels: number[] } {
  const ram = new Uint8Array(0x10000);
  ram.fill(0xc0, 0x1000, 0x1100);
  const doc = new Doc5503(ram, MEGA_HZ);
  const levels: number[] = [];
  doc.onOutput = (level) => levels.push(level);
  doc.write(0xe1, 1 << 1); // two oscillators
  doc.write(0x80, 0x10); // table at $1000
  doc.write(0xc0, 0x00); // 256 bytes, finest resolution
  doc.write(0x40, 0xff);
  doc.write(0x00, 0x00);
  doc.write(0x20, 0x02); // $200: one byte per pass
  doc.write(0xa0, control);
  return { doc, ram, levels };
}

describe('Ensoniq DOC', () => {
  it('plays a one-shot table, then halts and interrupts', () => {
    const { doc, levels } = setUp(0x02 | 0x08); // one-shot, interrupt enabled
    doc.run(MEGA_HZ / 100);
    expect(levels.some((level) => level === (0xc0 - 0x80) * 0xff)).toBe(true);
    expect(doc.read(0xa0) & 1).toBe(1);
    expect(doc.irq).toBe(true);
    expect(doc.read(0xe0)).toBe(0x41);
    expect(doc.irq).toBe(false);
    expect(doc.read(0xe0) & 0x80).toBe(0x80);
  });

  it('keeps a free-running oscillator going round its table', () => {
    const { doc } = setUp(0x00);
    doc.run(MEGA_HZ / 10);
    expect(doc.read(0xa0) & 1).toBe(0);
    expect(doc.irq).toBe(false);
  });

  it('stops at a zero sample', () => {
    const { doc, ram } = setUp(0x00);
    ram[0x1010] = 0;
    doc.run(MEGA_HZ / 100);
    expect(doc.read(0xa0) & 1).toBe(1);
  });

  it('starts the partner when a swap-mode oscillator ends', () => {
    const { doc } = setUp(0x06); // swap
    doc.write(0x81, 0x10); // oscillator 1 plays the same table, from halted, in swap mode
    doc.write(0x21, 0x02);
    doc.write(0xa1, 0x07);
    // Just past the end of the table: 256 passes over two oscillators (four DOC cycles each).
    doc.run(Math.ceil((257 * 4 * MEGA_HZ) / 894_886));
    expect(doc.read(0xa0) & 1).toBe(1);
    expect(doc.read(0xa1) & 1).toBe(0);
  });
});
