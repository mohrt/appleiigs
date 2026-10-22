import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Iigs } from '../../src/iigs';
import { textRowOffset } from '../../src/video/video';

export const romDir = join(import.meta.dirname, '..', '..', 'roms');
export const ROM_FILES = { rom01: 'apple2gs_rom01.rom', rom3: 'apple2gs_rom3.rom' } as const;
const CHAR_ROM = 'apple2gs.chr';

export function haveRom(file: string): boolean {
  return existsSync(join(romDir, file)) && existsSync(join(romDir, CHAR_ROM));
}

export function bootMachine(file: string): Iigs {
  const main = new Uint8Array(readFileSync(join(romDir, file)));
  const video = new Uint8Array(readFileSync(join(romDir, CHAR_ROM)));
  return new Iigs({ main, video });
}

/** Screen codes as text: normal, inverse and flashing letters all read as themselves. */
function character(code: number): string {
  let c = code & 0x7f;
  if (code < 0x80 && c >= 0x60) c -= 0x40;
  return String.fromCharCode(c < 0x20 ? c + 0x40 : c);
}

/** The text screen (page 1) in banks $E0-$E1, 40 or 80 columns. */
export function screenText(machine: Iigs): string[] {
  const col80 = machine.videoSwitches.col80;
  const lines: string[] = [];
  for (let row = 0; row < 24; row++) {
    let line = '';
    const base = 0x400 + textRowOffset(row);
    for (let col = 0; col < 40; col++) {
      if (col80) line += character(machine.slowRam[0x10000 + base + col]);
      line += character(machine.slowRam[base + col]);
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Writes the framebuffer as a PNG (for looking at a screen while debugging). */
export function savePng(path: string, pixels: Uint32Array, width: number, height: number): void {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const p = pixels[y * width + x];
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw[o] = p & 0xff;
      raw[o + 1] = (p >> 8) & 0xff;
      raw[o + 2] = (p >> 16) & 0xff;
      raw[o + 3] = 0xff;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}
