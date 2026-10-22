/** Mega II cycles: the IIgs's video keeps the Apple II's timing. */
export const CYCLES_PER_LINE = 65;
export const LINES_PER_FRAME = 262;
export const CYCLES_PER_FRAME = CYCLES_PER_LINE * LINES_PER_FRAME;
/** The Apple II modes have 192 lines; Super Hi-Res has 200. */
export const CLASSIC_LINES = 192;
export const SHR_LINES = 200;
/** Super Hi-Res is 640 dots wide; the Apple II modes' 560 sit in its middle. */
const ACTIVE_WIDTH = 640;
const CLASSIC_WIDTH = 560;
const CLASSIC_LEFT = (ACTIVE_WIDTH - CLASSIC_WIDTH) / 2;
const BORDER_X = 32;
const BORDER_Y = 16;
export const SCREEN_WIDTH = ACTIVE_WIDTH + BORDER_X * 2;
/** Each line is shown twice, so the picture keeps its shape. */
export const SCREEN_HEIGHT = (SHR_LINES + BORDER_Y * 2) * 2;
/** The first cycle of a line that fetches a byte shown on screen (the 40 before are the border and blanking). */
const FIRST_VISIBLE_CYCLE = 25;
const MIXED_TEXT_LINE = 160;
/** Flashing characters swap every this many frames (about twice a second). */
const FLASH_FRAMES = 16;

/** $C029: Super Hi-Res on (it also needs the linear memory layout of bit 6). */
export const NEWVIDEO_SHR = 0x80;
/** $C029: double hi-res in black and white. */
const NEWVIDEO_DHR_MONO = 0x20;
const SCB_640 = 0x80;
const SCB_INTERRUPT = 0x40;
const SCB_FILL = 0x20;
/** Super Hi-Res in bank $E1: the pixels, each line's control byte and the 16 palettes. */
const SHR_PIXELS = 0x2000;
const SHR_SCBS = 0x9d00;
const SHR_PALETTES = 0x9e00;
const SHR_BYTES_PER_LINE = 160;

export type Monitor = 'color' | 'green' | 'amber' | 'white';

/** The IIgs's 16 colours (as 12-bit RGB): lo-res, the text and border colours, and hi-res through RGB. */
const PALETTE_12 = [
  0x000, 0xd03, 0x009, 0xd2d, 0x072, 0x555, 0x22f, 0x6af, 0x850, 0xf60, 0xaaa, 0xf98, 0x1d0, 0xff0, 0x4f9, 0xfff,
];
const MONITOR_RGB: Record<Exclude<Monitor, 'color'>, number> = { green: 0x33ff66, amber: 0xffb000, white: 0xffffff };

/** RGB as a canvas pixel (little-endian RGBA). */
const pixel = (rgb: number) => 0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
/** 12-bit RGB (as the IIgs keeps colours) as a canvas pixel. */
const pixel12 = (rgb: number) => pixel(((rgb >> 8) & 0xf) * 0x110000 + ((rgb >> 4) & 0xf) * 0x1100 + (rgb & 0xf) * 0x11);
const PALETTE = Uint32Array.from(PALETTE_12, pixel12);
const BLACK = pixel(0);

/** Offset of a text (and lo-res) row in its page: the rows are interleaved in thirds. */
export function textRowOffset(row: number): number {
  return ((row & 7) << 7) | ((row >> 3) * 40);
}

/** Offset of a hi-res line in its page. */
export function hiresLineOffset(line: number): number {
  return ((line & 7) << 10) | textRowOffset(line >> 3);
}

/** The soft switches that choose what the screen shows. */
export class VideoSwitches {
  text = true;
  mixed = false;
  page2 = false;
  hires = false;
  col80 = false;
  store80 = false;
  altChar = false;
  /** Annunciator 3 off: double hi-res (and double lo-res) with 80 columns on. */
  dhires = false;
  /** $C029. */
  newVideo = 0x01;
  /** $C022: the text colour in the high nibble, the background in the low. */
  textColors = 0xf6;
  /** The low nibble of $C034. */
  border = 0x06;
}

/**
 * The IIgs's video (the VGC with the Mega II): the Apple II's text in 40
 * and 80 columns, lo-res, hi-res and their double versions in the IIgs's
 * RGB colours, with text in the Control Panel's colours, and Super Hi-Res
 * from bank $E1 with its line control bytes and palettes. Everything sits
 * inside a border. Lines are drawn as the beam finishes them.
 */
export class Video {
  readonly framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  monitor: Monitor = 'color';
  /**
   * Blends each dot of a 640-dot Super Hi-Res line with its neighbours, as a
   * monitor does: the dithered patterns 640-dot screens use for their colours
   * (such as the Finder's desktop) show as those colours rather than stripes.
   */
  blend640 = true;
  /** Cycle at which the frame being drawn started. */
  frameStart = 0;
  /** The next line to draw. */
  nextLine = 0;
  frames = 0;
  /** Called when a frame is complete. */
  onFrame: (framebuffer: Uint32Array) => void = () => {};
  /** Called as a Super Hi-Res line whose control byte asks for an interrupt is drawn. */
  onScanline: () => void = () => {};
  private readonly main: Uint8Array;
  private readonly aux: Uint8Array;
  /** Two dots of margin either side for the colour window. */
  private readonly dots = new Uint8Array(CLASSIC_WIDTH + 4);
  private readonly linePalette = new Uint32Array(16);
  private readonly blendBuffer = new Uint32Array(ACTIVE_WIDTH);

  constructor(
    private readonly switches: VideoSwitches,
    /** Banks $E0 and $E1, the memory the video shows. */
    slowRam: Uint8Array,
    private charRom: Uint8Array,
  ) {
    this.main = slowRam.subarray(0, 0x10000);
    this.aux = slowRam.subarray(0x10000, 0x20000);
  }

  setCharRom(rom: Uint8Array): void {
    this.charRom = rom;
  }

  /** Where the beam is: line 0-261 and cycle 0-64 within it. */
  beam(cycle: number): { line: number; h: number } {
    const position = (cycle - this.frameStart) % CYCLES_PER_FRAME;
    return { line: Math.floor(position / CYCLES_PER_LINE), h: position % CYCLES_PER_LINE };
  }

  /** In vertical blanking (lines 192-261). */
  inVbl(cycle: number): boolean {
    return (cycle - this.frameStart) % CYCLES_PER_FRAME >= CLASSIC_LINES * CYCLES_PER_LINE;
  }

  /** Draws the lines the beam has finished by `cycle`. */
  catchUp(cycle: number): void {
    for (;;) {
      const position = cycle - this.frameStart;
      while (this.nextLine < SHR_LINES && (this.nextLine + 1) * CYCLES_PER_LINE <= position) this.drawLine(this.nextLine++);
      if (position < CYCLES_PER_FRAME) return;
      this.drawTopAndBottomBorders();
      this.frameStart += CYCLES_PER_FRAME;
      this.nextLine = 0;
      this.frames++;
      this.onFrame(this.framebuffer);
    }
  }

  /** The byte the video is fetching at `cycle`, which is what reads of unconnected addresses return. */
  floatingBus(cycle: number): number {
    const { line, h } = this.beam(cycle);
    const s = this.switches;
    const v = line & 0xff;
    const page = s.page2 && !s.store80 ? 2 : 1;
    const low = ((((v >> 6) & 3) * 40 + h - FIRST_VISIBLE_CYCLE) & 0x7f) | (((v >> 3) & 7) << 7);
    const graphics = !s.text && !(s.mixed && v >= MIXED_TEXT_LINE && v < CLASSIC_LINES);
    const address = graphics && s.hires ? page * 0x2000 + ((v & 7) << 10) + low : page * 0x400 + low;
    return this.main[address];
  }

  private get flashOn(): boolean {
    return Math.floor(this.frames / FLASH_FRAMES) % 2 === 1;
  }

  private get borderPixel(): number {
    return this.tint(PALETTE[this.switches.border & 0x0f]);
  }

  /** In a monochrome monitor's colour, by brightness. */
  private tint(value: number): number {
    if (this.monitor === 'color') return value;
    const luma = ((value & 0xff) * 77 + ((value >> 8) & 0xff) * 150 + ((value >> 16) & 0xff) * 29) >> 8;
    const rgb = MONITOR_RGB[this.monitor];
    const scale = (shift: number) => (((rgb >> shift) & 0xff) * luma) >> 8;
    return pixel((scale(16) << 16) | (scale(8) << 8) | scale(0));
  }

  private drawLine(line: number): void {
    const s = this.switches;
    const fb = this.framebuffer;
    const row = (BORDER_Y + line) * 2 * SCREEN_WIDTH;
    const border = this.borderPixel;
    fb.fill(border, row, row + BORDER_X);
    fb.fill(border, row + BORDER_X + ACTIVE_WIDTH, row + SCREEN_WIDTH);
    if (s.newVideo & NEWVIDEO_SHR) this.superHires(line, row + BORDER_X);
    else if (line < CLASSIC_LINES) this.classicLine(line, row + BORDER_X);
    else fb.fill(border, row + BORDER_X, row + BORDER_X + ACTIVE_WIDTH);
    fb.copyWithin(row + SCREEN_WIDTH, row, row + SCREEN_WIDTH);
  }

  private drawTopAndBottomBorders(): void {
    const border = this.borderPixel;
    const bandRows = BORDER_Y * 2 * SCREEN_WIDTH;
    this.framebuffer.fill(border, 0, bandRows);
    this.framebuffer.fill(border, this.framebuffer.length - bandRows);
  }

  // --- The Apple II modes ------------------------------------------------------------

  private classicLine(line: number, start: number): void {
    const s = this.switches;
    const page = s.page2 && !s.store80 ? 1 : 0;
    const doubled = s.col80 && s.dhires;
    const text = s.text || (s.mixed && line >= MIXED_TEXT_LINE);
    this.dots.fill(0);
    if (text) {
      if (s.col80) this.text80(line, page);
      else this.text40(line, page);
    } else if (s.hires) {
      if (doubled) this.doubleHires(line, page);
      else this.hires(line, page);
    } else if (doubled) {
      this.doubleLores(line, page);
    } else {
      this.lores(line, page);
    }
    const border = this.borderPixel;
    const fb = this.framebuffer;
    fb.fill(border, start, start + CLASSIC_LEFT);
    fb.fill(border, start + CLASSIC_LEFT + CLASSIC_WIDTH, start + ACTIVE_WIDTH);
    const dotsStart = start + CLASSIC_LEFT;
    if (text) {
      this.twoColors(dotsStart, PALETTE[s.textColors >> 4], PALETTE[s.textColors & 0x0f]);
    } else if (s.hires && doubled && s.newVideo & NEWVIDEO_DHR_MONO) {
      this.twoColors(dotsStart, PALETTE[15], BLACK);
    } else {
      this.colorize(dotsStart);
    }
  }

  /**
   * The 7 dots of a character's row (bit 0 is the leftmost), lit where the
   * ROM has a 0. The ROM's first 2K is the primary set, the second the
   * alternate set with MouseText.
   */
  private glyphRow(code: number, row: number): number {
    let index = code;
    if (this.switches.altChar) index |= 0x100;
    else if (code >= 0x40 && code < 0x80) {
      // Flashing characters alternate between inverse and normal.
      index = (code & 0x3f) | (this.flashOn ? 0 : 0x80);
    }
    return ~this.charRom[index * 8 + row] & 0x7f;
  }

  private text40(line: number, page: number): void {
    const base = 0x400 + page * 0x400 + textRowOffset(line >> 3);
    const dots = this.dots;
    for (let col = 0; col < 40; col++) {
      const glyph = this.glyphRow(this.main[base + col], line & 7);
      let x = 2 + col * 14;
      for (let bit = 0; bit < 7; bit++) {
        const on = (glyph >> bit) & 1;
        dots[x++] = on;
        dots[x++] = on;
      }
    }
  }

  private text80(line: number, page: number): void {
    const base = 0x400 + page * 0x400 + textRowOffset(line >> 3);
    const dots = this.dots;
    let x = 2;
    for (let col = 0; col < 40; col++) {
      for (const memory of [this.aux, this.main]) {
        const glyph = this.glyphRow(memory[base + col], line & 7);
        for (let bit = 0; bit < 7; bit++) dots[x++] = (glyph >> bit) & 1;
      }
    }
  }

  private lores(line: number, page: number): void {
    const base = 0x400 + page * 0x400 + textRowOffset(line >> 3);
    const shift = line & 4;
    const dots = this.dots;
    for (let col = 0; col < 40; col++) {
      const color = (this.main[base + col] >> shift) & 0x0f;
      for (let x = col * 14; x < col * 14 + 14; x++) dots[x + 2] = (color >> (x & 3)) & 1;
    }
  }

  private doubleLores(line: number, page: number): void {
    const base = 0x400 + page * 0x400 + textRowOffset(line >> 3);
    const shift = line & 4;
    const dots = this.dots;
    for (let col = 0; col < 40; col++) {
      // Aux memory holds its colours rotated a bit right.
      const auxColor = (this.aux[base + col] >> shift) & 0x0f;
      const color = [((auxColor << 1) | (auxColor >> 3)) & 0x0f, (this.main[base + col] >> shift) & 0x0f];
      for (let x = col * 14; x < col * 14 + 14; x++) dots[x + 2] = (color[x - col * 14 < 7 ? 0 : 1] >> (x & 3)) & 1;
    }
  }

  private hires(line: number, page: number): void {
    const base = 0x2000 + page * 0x2000 + hiresLineOffset(line);
    const dots = this.dots;
    for (let col = 0; col < 40; col++) {
      const byte = this.main[base + col];
      let x = 2 + col * 14;
      if (byte & 0x80) {
        // The palette bit delays the byte's dots by half a dot; the previous dot fills the gap.
        dots[x] = col > 0 ? dots[x - 1] : 0;
        x++;
      }
      for (let bit = 0; bit < 7; bit++) {
        const on = (byte >> bit) & 1;
        dots[x++] = on;
        dots[x++] = on;
      }
    }
  }

  private doubleHires(line: number, page: number): void {
    const base = 0x2000 + page * 0x2000 + hiresLineOffset(line);
    const dots = this.dots;
    let x = 2;
    for (let col = 0; col < 40; col++) {
      for (const byte of [this.aux[base + col], this.main[base + col]]) {
        for (let bit = 0; bit < 7; bit++) dots[x++] = (byte >> bit) & 1;
      }
    }
  }

  private twoColors(start: number, on: number, off: number): void {
    const fb = this.framebuffer;
    const dots = this.dots;
    const lit = this.tint(on);
    const unlit = this.tint(off);
    for (let x = 0; x < CLASSIC_WIDTH; x++) fb[start + x] = dots[x + 2] ? lit : unlit;
  }

  /** Each dot gets the colour the four dots from one before it to two after make, by their phase in the colour cycle. */
  private colorize(start: number): void {
    const fb = this.framebuffer;
    const dots = this.dots;
    let pattern = 0;
    for (let x = -1; x <= 1; x++) if (dots[x + 2]) pattern |= 1 << (x & 3);
    for (let x = 0; x < CLASSIC_WIDTH; x++) {
      const entering = x + 2;
      const phase = entering & 3;
      pattern = (pattern & ~(1 << phase)) | ((entering < CLASSIC_WIDTH ? dots[entering + 2] : 0) << phase);
      fb[start + x] = this.tint(PALETTE[pattern]);
    }
  }

  // --- Super Hi-Res ---------------------------------------------------------------------

  /** Each dot of a 640-dot line as half itself and a quarter of each neighbour. */
  private blendLine(start: number): void {
    const fb = this.framebuffer;
    const line = this.blendBuffer;
    line.set(fb.subarray(start, start + ACTIVE_WIDTH));
    for (let x = 0; x < ACTIVE_WIDTH; x++) {
      const left = line[x > 0 ? x - 1 : x];
      const centre = line[x];
      const right = line[x < ACTIVE_WIDTH - 1 ? x + 1 : x];
      let mixed = 0xff000000;
      for (let shift = 0; shift < 24; shift += 8) {
        const channel = (((left >> shift) & 0xff) + ((centre >> shift) & 0xff) * 2 + ((right >> shift) & 0xff)) >> 2;
        mixed |= channel << shift;
      }
      fb[start + x] = mixed >>> 0;
    }
  }

  private superHires(line: number, start: number): void {
    const aux = this.aux;
    const scb = aux[SHR_SCBS + line];
    if (scb & SCB_INTERRUPT) this.onScanline();
    const palette = this.linePalette;
    const paletteBase = SHR_PALETTES + (scb & 0x0f) * 32;
    for (let i = 0; i < 16; i++) palette[i] = this.tint(pixel12(aux[paletteBase + i * 2] | (aux[paletteBase + i * 2 + 1] << 8)));
    const fb = this.framebuffer;
    const base = SHR_PIXELS + line * SHR_BYTES_PER_LINE;
    let x = start;
    if (scb & SCB_640) {
      // Four dots a byte, the first two from colours 8-15 and the last two from 0-7.
      for (let i = 0; i < SHR_BYTES_PER_LINE; i++) {
        const byte = aux[base + i];
        fb[x++] = palette[8 + (byte >> 6)];
        fb[x++] = palette[12 + ((byte >> 4) & 3)];
        fb[x++] = palette[(byte >> 2) & 3];
        fb[x++] = palette[4 + (byte & 3)];
      }
      if (this.blend640) this.blendLine(start);
      return;
    }
    const fill = (scb & SCB_FILL) !== 0;
    let previous = palette[0];
    for (let i = 0; i < SHR_BYTES_PER_LINE * 2; i++) {
      const byte = aux[base + (i >> 1)];
      const index = i & 1 ? byte & 0x0f : byte >> 4;
      // In fill mode, colour 0 repeats the dot before.
      const value = fill && index === 0 ? previous : palette[index];
      previous = value;
      fb[x++] = value;
      fb[x++] = value;
    }
  }
}
