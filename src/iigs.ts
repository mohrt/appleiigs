import { Cpu65816, type Bus816 } from './cpu/cpu65816';
import { Disk2 } from './disk/disk2';
import type { FloppyDisk } from './disk/floppy';
import { Adb, Modifier } from './io/adb';
import { Clock } from './io/clock';
import { Scc } from './io/scc';
import { SoundGlu } from './sound/sound-glu';
import { CLASSIC_LINES, CYCLES_PER_FRAME, CYCLES_PER_LINE, Video, VideoSwitches } from './video/video';

/** The master clock, 14.31818 MHz, counted in ticks. */
export const MASTER_HZ = 14_318_180;
/** A Mega II (1 MHz) cycle is 14 ticks, except the last of each line's 65, which is 16. */
const TICKS_PER_LINE = 912;
const SLOW_TICKS = 14;
const LAST_CYCLE_TICK = (CYCLES_PER_LINE - 1) * SLOW_TICKS;
/** A 2.8 MHz cycle. */
const FAST_TICKS = 5;
/** Mega II cycles a second: the Apple II's 1.02 MHz, which the machine's time is counted in. */
export const CLOCK_HZ = (MASTER_HZ * CYCLES_PER_LINE) / TICKS_PER_LINE;
export const DISK_SLOT = 6;
/** Each count of a paddle's value holds its timer for about 11 µs. */
const PADDLE_CYCLES_PER_UNIT = 11;
export const PADDLE_CENTRE = 127;
/** Banks of fast RAM (64K each): 4 MB, starting at bank $00. */
export const DEFAULT_RAM_BANKS = 0x40;
export const MAX_RAM_BANKS = 0x80;
const SLOW_BANK = 0xe0;
const ROM_LAST_BANK = 0xff;
/** Vertical blanks (60 a second) per quarter-second and one-second interrupt. */
const VBLS_PER_QUARTER_SECOND = 15;
const VBLS_PER_SECOND = 60;

// $C035, SHADOW: what is not copied to the Mega II's memory in banks $E0-$E1.
const SHADOW_NO_TEXT1 = 0x01;
const SHADOW_NO_HIRES1 = 0x02;
const SHADOW_NO_HIRES2 = 0x04;
const SHADOW_NO_SHR = 0x08;
const SHADOW_NO_AUX_HIRES = 0x10;
const SHADOW_NO_TEXT2 = 0x20;
/** Banks $00-$01 without I/O or the language card at $C000-$FFFF: just RAM. */
const SHADOW_NO_IOLC = 0x40;
// $C036, CYAREG.
const SPEED_FAST = 0x80;
/** Slow down while slot 6's disk motor turns. */
const SPEED_SLOT6_MOTOR = 0x04;
// $C041 and $C046: the Mega II's interrupts.
const INT_VBL = 0x08;
const INT_QUARTER_SECOND = 0x10;
// $C023: the VGC's interrupts, enabled in bits 1-2, flagged in 5-6.
const VGC_SCANLINE_ENABLE = 0x02;
const VGC_SECOND_ENABLE = 0x04;
const VGC_SCANLINE = 0x20;
const VGC_SECOND = 0x40;
/** $C031: the IWM is talking to the 3.5" drives. */
const DISKREG_35 = 0x40;

export interface Roms {
  /** ROM 01's 128K (banks $FE-$FF) or ROM 3's 256K (banks $FC-$FF). */
  main: Uint8Array;
  /** The 4K character ROM (the enhanced IIe's characters with MouseText). */
  video: Uint8Array;
}

/** ROM 01 is 128K; ROM 3 is 256K. */
export const romVersionOf = (main: Uint8Array) => (main.length > 0x20000 ? 3 : 1);

/** The IIe's memory soft switches (in the Mega II) and the language card. */
class MemorySwitches {
  ramRd = false;
  ramWrt = false;
  altZp = false;
  intCxRom = false;
  slotC3Rom = false;
  lcBank2 = true;
  lcReadRam = false;
  lcWrite = true;
  lcPrewrite = false;
}

/** Where a Mega II cycle starts at or after `tick`. */
function slowEdge(tick: number): number {
  const lineStart = Math.floor(tick / TICKS_PER_LINE) * TICKS_PER_LINE;
  const into = tick - lineStart;
  if (into > LAST_CYCLE_TICK) return lineStart + TICKS_PER_LINE;
  return lineStart + Math.ceil(into / SLOW_TICKS) * SLOW_TICKS;
}

/** The end of a Mega II cycle that starts at `edge`. */
function slowCycleEnd(edge: number): number {
  return edge + (edge % TICKS_PER_LINE === LAST_CYCLE_TICK ? TICKS_PER_LINE - LAST_CYCLE_TICK : SLOW_TICKS);
}

/** The Mega II cycle `tick` falls in. */
function megaCycle(tick: number): number {
  const line = Math.floor(tick / TICKS_PER_LINE);
  return line * CYCLES_PER_LINE + Math.min(Math.floor((tick - line * TICKS_PER_LINE) / SLOW_TICKS), CYCLES_PER_LINE - 1);
}

/**
 * An Apple IIgs: the 65C816 at 2.8 MHz in fast RAM (banks $00 up), the
 * Mega II's 128K of slow RAM in banks $E0-$E1 that the video shows, and the
 * ROM in the top banks. Banks $00 and $01 behave as the IIe's main and
 * auxiliary memory, with I/O and the language card at $C000-$FFFF, and their
 * display areas are shadowed: written through to banks $E0 and $E1 at the
 * Mega II's 1 MHz. Any access to the Mega II's memory or I/O waits for its
 * clock. Around it are the VGC's video and interrupts, the ADB keyboard and
 * mouse, the clock and battery RAM, the sound GLU, the serial chip and the IWM
 * with the 5.25" drives in slot 6.
 */
export class Iigs implements Bus816 {
  readonly ram: Uint8Array;
  /** Banks $E0 and $E1. */
  readonly slowRam = new Uint8Array(0x20000);
  rom!: Uint8Array;
  romVersion = 3;
  readonly cpu: Cpu65816;
  readonly videoSwitches = new VideoSwitches();
  readonly video: Video;
  readonly memory = new MemorySwitches();
  readonly adb: Adb;
  readonly clock = new Clock();
  readonly sound = new SoundGlu();
  readonly scc = new Scc();
  readonly disk2: Disk2;

  /** The master clock. */
  ticks = 0;
  /** $C035, $C036, $C02D, $C031, $C037, $C02B and $C021. */
  shadow = 0;
  speed = SPEED_FAST;
  slotRomSelect = 0;
  diskReg = 0;
  dmaReg = 0;
  languageReg = 0;
  monoColor = 0;
  /** $C041 and the flags of $C046. */
  intEnable = 0;
  intFlags = 0;
  /** $C023's enables and flags. */
  vgcInterrupts = 0;
  vblCount = 0;

  // The game port
  /** The joystick's buttons, alongside the Command and Option keys. */
  readonly buttons = [false, false, false];
  readonly paddles = [PADDLE_CENTRE, PADDLE_CENTRE, PADDLE_CENTRE, PADDLE_CENTRE];
  paddleTriggered = -1_000_000;
  /** Keys waiting to be typed. */
  private keyQueue: number[] = [];

  /** The Mega II cycle of the slow access being made, for I/O. */
  private now = 0;
  private fast = true;
  /** CPU cycles already counted on the master clock in this instruction. */
  private cyclesSeen = 0;
  private nextVbl = CLASSIC_LINES * CYCLES_PER_LINE;
  private romBanks = 4;

  /** For each 256-byte page of the 16 MB: the memory it reads and writes, where in it, and its shadow in banks $E0-$E1. */
  private readonly readMem: (Uint8Array | null)[] = new Array(0x10000).fill(null);
  private readonly readBase = new Int32Array(0x10000);
  private readonly writeMem: (Uint8Array | null)[] = new Array(0x10000).fill(null);
  private readonly writeBase = new Int32Array(0x10000);
  private readonly writeShadow = new Int32Array(0x10000).fill(-1);
  /** Pages in the Mega II's memory, which run at its speed. */
  private readonly slowPage = new Uint8Array(0x10000);
  /** Where writes to ROM go. */
  private readonly sink = new Uint8Array(0x100);

  constructor(
    roms: Roms,
    readonly ramBanks = DEFAULT_RAM_BANKS,
  ) {
    this.ram = new Uint8Array(ramBanks * 0x10000);
    this.cpu = new Cpu65816(this);
    this.cpu.vectorBank = ROM_LAST_BANK;
    this.adb = new Adb(3);
    this.video = new Video(this.videoSwitches, this.slowRam, roms.video);
    this.video.onScanline = () => {
      if (this.vgcInterrupts & VGC_SCANLINE_ENABLE) this.vgcInterrupts |= VGC_SCANLINE;
    };
    this.disk2 = new Disk2(new Uint8Array(0x100));
    this.disk2.iwm = true;
    this.setRoms(roms);
  }

  /** Puts in a ROM (ROM 01 or ROM 3) and its character set, followed by a power cycle. */
  setRoms(roms: Roms): void {
    this.romVersion = romVersionOf(roms.main);
    this.romBanks = roms.main.length >> 16;
    this.rom = roms.main;
    this.adb.romVersion = this.romVersion;
    this.video.setCharRom(roms.video);
    this.mapFixedBanks();
    this.powerOn();
  }

  // --- Power and reset ------------------------------------------------------------

  /** Switches the IIgs off and on: memory cleared, everything back to its power-on state. */
  powerOn(): void {
    this.ram.fill(0);
    this.slowRam.fill(0);
    Object.assign(this.videoSwitches, new VideoSwitches());
    this.shadow = 0;
    this.speed = SPEED_FAST;
    this.slotRomSelect = 0;
    this.intEnable = this.intFlags = this.vgcInterrupts = 0;
    this.keyQueue = [];
    this.adb.keyStrobe = false;
    this.disk2.drives.forEach((drive) => (drive.quarterTrack = 0));
    this.reset();
  }

  /** The RESET line (Ctrl-Reset): the memory switches, the cards and the CPU restart; memory is kept. */
  reset(): void {
    Object.assign(this.memory, new MemorySwitches());
    const video = this.videoSwitches;
    video.store80 = video.col80 = video.altChar = false;
    this.shadow &= ~SHADOW_NO_IOLC;
    this.adb.reset();
    this.clock.reset();
    this.scc.reset();
    this.disk2.reset();
    this.diskReg = 0;
    this.updatePages();
    this.cpu.reset();
  }

  // --- Running ------------------------------------------------------------------

  /** The Mega II cycle the machine has reached. */
  get cycles(): number {
    return megaCycle(this.ticks);
  }

  /** Runs for at least `budget` Mega II cycles; returns the cycles run. */
  runCycles(budget: number): number {
    const start = this.cycles;
    const end = start + budget;
    const cpu = this.cpu;
    let now = start;
    while (now < end) {
      if (this.keyQueue.length !== 0 && !this.adb.keyStrobe) this.adb.pressKey(this.keyQueue.shift()!, 0);
      this.fast = (this.speed & SPEED_FAST) !== 0 && !(this.speed & SPEED_SLOT6_MOTOR && this.disk2.spinning(now));
      cpu.irqLine = this.irqAsserted;
      this.cyclesSeen = cpu.cycles;
      cpu.step();
      this.spendIdle(cpu.cycles - this.cyclesSeen);
      now = this.cycles;
      if (now >= this.nextVbl) this.verticalBlank();
      this.video.catchUp(now);
    }
    return now - start;
  }

  private get irqAsserted(): boolean {
    return (this.intFlags & this.intEnable) !== 0 || (this.vgcInterrupts & (VGC_SCANLINE | VGC_SECOND)) !== 0 || this.adb.irq;
  }

  /** The start of each vertical blank: the VBL, quarter-second and one-second interrupts. */
  private verticalBlank(): void {
    this.nextVbl += CYCLES_PER_FRAME;
    this.vblCount++;
    if (this.intEnable & INT_VBL) this.intFlags |= INT_VBL;
    if (this.vblCount % VBLS_PER_QUARTER_SECOND === 0 && this.intEnable & INT_QUARTER_SECOND) this.intFlags |= INT_QUARTER_SECOND;
    if (this.vblCount % VBLS_PER_SECOND === 0 && this.vgcInterrupts & VGC_SECOND_ENABLE) this.vgcInterrupts |= VGC_SECOND;
  }

  // --- Timing ------------------------------------------------------------------------

  /** Internal CPU cycles, at the current speed. */
  private spendIdle(cycles: number): void {
    if (cycles <= 0) return;
    this.cyclesSeen += cycles;
    if (this.fast) this.ticks += cycles * FAST_TICKS;
    else for (let i = 0; i < cycles; i++) this.ticks = slowCycleEnd(slowEdge(this.ticks));
  }

  /** A bus cycle: fast, or waiting for and taking a whole Mega II cycle. */
  private busCycle(slow: boolean): void {
    this.spendIdle(this.cpu.cycles - 1 - this.cyclesSeen);
    this.cyclesSeen = this.cpu.cycles;
    if (this.fast && !slow) {
      this.ticks += FAST_TICKS;
      return;
    }
    const edge = slowEdge(this.ticks);
    this.now = megaCycle(edge);
    this.ticks = slowCycleEnd(edge);
  }

  // --- Memory map -----------------------------------------------------------------

  read(addr: number): number {
    const page = addr >>> 8;
    const memory = this.readMem[page];
    if (memory !== null) {
      this.busCycle(this.slowPage[page] === 1);
      return memory[this.readBase[page] + (addr & 0xff)];
    }
    if (!this.isIoBank(addr >>> 16)) {
      this.busCycle(false);
      return 0;
    }
    this.busCycle(true);
    return (addr & 0xff00) === 0xc000 ? this.io(addr & 0xff, null) : this.slotSpace(addr & 0xffff);
  }

  write(addr: number, value: number): void {
    const page = addr >>> 8;
    const memory = this.writeMem[page];
    if (memory !== null) {
      const shadow = this.writeShadow[page];
      this.busCycle(shadow >= 0 || this.slowPage[page] === 1);
      memory[this.writeBase[page] + (addr & 0xff)] = value;
      if (shadow >= 0) this.slowRam[shadow + (addr & 0xff)] = value;
      return;
    }
    const io = this.isIoBank(addr >>> 16);
    this.busCycle(io);
    if (io && (addr & 0xff00) === 0xc000) this.io(addr & 0xff, value);
  }

  /** Banks with I/O at $C000-$CFFF. */
  private isIoBank(bank: number): boolean {
    return bank === 0 || bank === 1 || bank === SLOW_BANK || bank === SLOW_BANK + 1;
  }

  /** The offset in the ROM image of an address in bank `bank` ($FC-$FF). */
  private romOffset(bank: number, offset: number): number {
    return this.rom.length - (0x100 - bank) * 0x10000 + offset;
  }

  private setPage(page: number, read: Uint8Array | null, readBase: number, write: Uint8Array | null, writeBase: number, shadow = -1, slow = false): void {
    this.readMem[page] = read;
    this.readBase[page] = readBase;
    this.writeMem[page] = write;
    this.writeBase[page] = writeBase;
    this.writeShadow[page] = shadow;
    this.slowPage[page] = slow ? 1 : 0;
  }

  /** Fast RAM above bank $01, the ROM and the empty banks, which no switch changes. */
  private mapFixedBanks(): void {
    for (let bank = 2; bank < 0x100; bank++) {
      for (let p = 0; p < 0x100; p++) {
        const page = (bank << 8) | p;
        if (bank < this.ramBanks) this.setPage(page, this.ram, page << 8, this.ram, page << 8);
        else if (bank >= 0x100 - this.romBanks) this.setPage(page, this.rom, this.romOffset(bank, p << 8), this.sink, 0);
        else this.setPage(page, null, 0, null, 0);
      }
    }
  }

  /** Where a write to page `p` of bank $00 or $01 is shadowed in banks $E0-$E1, or -1. */
  private shadowOf(bank: number, p: number): number {
    const s = this.shadow;
    let shadowed = false;
    if (p >= 0x04 && p < 0x08) shadowed = !(s & SHADOW_NO_TEXT1);
    else if (p >= 0x08 && p < 0x0c) shadowed = this.romVersion >= 3 && !(s & SHADOW_NO_TEXT2);
    else if (p >= 0x20 && p < 0x60) {
      const inhibit = p < 0x40 ? SHADOW_NO_HIRES1 : SHADOW_NO_HIRES2;
      shadowed = bank === 0 ? !(s & inhibit) : (!(s & inhibit) && !(s & SHADOW_NO_AUX_HIRES)) || !(s & SHADOW_NO_SHR);
    } else if (p >= 0x60 && p < 0xa0) shadowed = bank === 1 && !(s & SHADOW_NO_SHR);
    return shadowed ? (bank << 16) | (p << 8) : -1;
  }

  /** Works out banks $00, $01, $E0 and $E1 from the soft switches and the shadow register. */
  private updatePages(): void {
    const m = this.memory;
    const v = this.videoSwitches;
    const ram = this.ram;
    const ioLc = !(this.shadow & SHADOW_NO_IOLC);
    for (const bank of [0, 1]) {
      for (let p = 0; p < 0x100; p++) {
        if (p >= 0xc0 && ioLc) break;
        let readBank = bank;
        let writeBank = bank;
        if (bank === 0 && p < 0xc0) {
          if (p < 0x02) readBank = writeBank = m.altZp ? 1 : 0;
          else if (v.store80 && ((p >= 0x04 && p < 0x08) || (v.hires && p >= 0x20 && p < 0x40))) readBank = writeBank = v.page2 ? 1 : 0;
          else {
            readBank = m.ramRd ? 1 : 0;
            writeBank = m.ramWrt ? 1 : 0;
          }
        }
        const write = (writeBank << 16) | (p << 8);
        this.setPage((bank << 8) | p, ram, (readBank << 16) | (p << 8), ram, write, this.shadowOf(writeBank, p));
      }
      if (ioLc) {
        for (let p = 0xc0; p < 0xd0; p++) this.setPage((bank << 8) | p, null, 0, null, 0);
        this.mapLanguageCard(bank, ram, (bank === 0 && m.altZp ? 1 : bank) << 16, false);
      }
    }
    for (const bank of [SLOW_BANK, SLOW_BANK + 1]) {
      const base = (bank - SLOW_BANK) << 16;
      for (let p = 0; p < 0xc0; p++) this.setPage((bank << 8) | p, this.slowRam, base | (p << 8), this.slowRam, base | (p << 8), -1, true);
      for (let p = 0xc0; p < 0xd0; p++) this.setPage((bank << 8) | p, null, 0, null, 0);
      this.mapLanguageCard(bank, this.slowRam, base, true);
    }
  }

  /** $D000-$FFFF of a bank: the language card's 16K of RAM (two banks at $D000) over the ROM. */
  private mapLanguageCard(bank: number, memory: Uint8Array, base: number, slow: boolean): void {
    const m = this.memory;
    for (let p = 0xd0; p < 0x100; p++) {
      // Bank 1 of $D000 is kept where $C000 would be, which is never RAM otherwise.
      const ram = base | ((p < 0xe0 && !m.lcBank2 ? p - 0x10 : p) << 8);
      const read = m.lcReadRam ? memory : this.rom;
      const readBase = m.lcReadRam ? ram : this.romOffset(ROM_LAST_BANK, p << 8);
      this.setPage((bank << 8) | p, read, readBase, m.lcWrite ? memory : this.sink, m.lcWrite ? ram : 0, -1, slow);
    }
  }

  /** $C100-$CFFF: the internal firmware in ROM, or the (empty) slots $C02D gives to cards. */
  private slotSpace(addr: number): number {
    const m = this.memory;
    const slot = (addr >> 8) & 0x0f;
    const internal =
      addr >= 0xc800 || m.intCxRom || (slot === 3 ? !m.slotC3Rom : (this.slotRomSelect & (1 << slot)) === 0);
    return internal ? this.rom[this.romOffset(ROM_LAST_BANK, addr)] : this.video.floatingBus(this.now);
  }

  // --- I/O ------------------------------------------------------------------------

  private bit(on: boolean): number {
    return (on ? 0x80 : 0) | (this.adb.keyLatch & 0x7f);
  }

  /** $C000-$C0FF, read (`value` null) or written. */
  private io(reg: number, value: number | null): number {
    const m = this.memory;
    const v = this.videoSwitches;
    const adb = this.adb;
    if (reg < 0x10) {
      if (value === null) return adb.keyLatch | (adb.keyStrobe ? 0x80 : 0);
      this.memorySwitch(reg);
      return 0;
    }
    if (reg < 0x20) {
      if (reg === 0x10 || value !== null) {
        adb.keyStrobe = false;
        return this.bit(adb.anyKeyDown);
      }
      switch (reg) {
        case 0x11: return this.bit(m.lcBank2);
        case 0x12: return this.bit(m.lcReadRam);
        case 0x13: return this.bit(m.ramRd);
        case 0x14: return this.bit(m.ramWrt);
        case 0x15: return this.bit(m.intCxRom);
        case 0x16: return this.bit(m.altZp);
        case 0x17: return this.bit(m.slotC3Rom);
        case 0x18: return this.bit(v.store80);
        // Unlike the IIe's, the IIgs's VBL bit is set during the blank.
        case 0x19: return this.bit(this.video.inVbl(this.now));
        case 0x1a: return this.bit(v.text);
        case 0x1b: return this.bit(v.mixed);
        case 0x1c: return this.bit(v.page2);
        case 0x1d: return this.bit(v.hires);
        case 0x1e: return this.bit(v.altChar);
        default: return this.bit(v.col80);
      }
    }
    if (reg < 0x40) return value === null ? this.readIigsRegister(reg) : (this.writeIigsRegister(reg, value), 0);
    if (reg < 0x50) return this.megaIiInterrupts(reg, value);
    if (reg < 0x60) this.displaySwitch(reg);
    else if (reg < 0x68) return this.gamePort(reg & 7) | (this.video.floatingBus(this.now) & 0x7f);
    else if (reg === 0x68) return value === null ? this.stateReg : (this.setStateReg(value), 0);
    else if (reg === 0x70) this.paddleTriggered = this.now;
    // $C071-$C07F show the ROM: the firmware's interrupt entry points are there.
    else if (reg > 0x70 && reg < 0x80) return this.rom[this.romOffset(ROM_LAST_BANK, 0xc000 | reg)];
    else if (reg >= 0x80 && reg < 0x90) this.languageCard(reg, value !== null);
    else if (reg >= 0x90 && (reg >> 4) - 8 === DISK_SLOT) {
      this.disk2.drive35 = (this.diskReg & DISKREG_35) !== 0;
      return this.disk2.access(reg & 0x0f, value, this.now);
    }
    return this.video.floatingBus(this.now);
  }

  /** $C020-$C03F read. */
  private readIigsRegister(reg: number): number {
    const v = this.videoSwitches;
    switch (reg) {
      case 0x21: return this.monoColor;
      case 0x22: return v.textColors;
      case 0x23: return this.vgcInterrupts | (this.vgcInterrupts & (VGC_SCANLINE | VGC_SECOND) ? 0x80 : 0);
      case 0x24: case 0x25: case 0x26: case 0x27: return this.adb.read(reg);
      case 0x29: return v.newVideo;
      case 0x2b: return this.languageReg;
      case 0x2d: return this.slotRomSelect;
      case 0x2e: return this.verticalCount >> 1;
      case 0x2f: return ((this.verticalCount & 1) << 7) | this.horizontalCount;
      case 0x30: return this.video.floatingBus(this.now);
      case 0x31: return this.diskReg;
      case 0x33: return this.clock.data;
      case 0x34: return this.clock.control | v.border;
      case 0x35: return this.shadow;
      case 0x36: return this.speed;
      case 0x37: return this.dmaReg;
      case 0x38: case 0x39: case 0x3a: case 0x3b: return this.scc.read(reg);
      case 0x3c: case 0x3d: case 0x3e: case 0x3f: return this.sound.read(reg);
    }
    return 0;
  }

  /** $C020-$C03F written. */
  private writeIigsRegister(reg: number, value: number): void {
    const v = this.videoSwitches;
    switch (reg) {
      case 0x21: this.monoColor = value; break;
      case 0x22:
        this.video.catchUp(this.now);
        v.textColors = value;
        break;
      case 0x23: this.vgcInterrupts = (this.vgcInterrupts & (VGC_SCANLINE | VGC_SECOND)) | (value & 0x0f); break;
      case 0x26: case 0x27: this.adb.write(reg, value); break;
      case 0x29:
        this.video.catchUp(this.now);
        v.newVideo = value;
        break;
      case 0x2b: this.languageReg = value; break;
      case 0x2d: this.slotRomSelect = value; break;
      case 0x31: this.diskReg = value; break;
      // Writing 0 to bit 5 or 6 clears the scanline or one-second interrupt.
      case 0x32: this.vgcInterrupts &= value | ~(VGC_SCANLINE | VGC_SECOND); break;
      case 0x33: this.clock.data = value; break;
      case 0x34:
        this.video.catchUp(this.now);
        v.border = value & 0x0f;
        if (value & 0x80) this.clock.transfer(value);
        break;
      case 0x35:
        this.shadow = value;
        this.updatePages();
        break;
      case 0x36: this.speed = value; break;
      case 0x37: this.dmaReg = value; break;
      case 0x38: case 0x39: case 0x3a: case 0x3b: this.scc.write(reg, value); break;
      case 0x3c: case 0x3d: case 0x3e: case 0x3f: this.sound.write(reg, value); break;
    }
  }

  /** $C040-$C04F: the Mega II's interrupt enables ($C041), flags ($C046) and clearing ($C047). */
  private megaIiInterrupts(reg: number, value: number | null): number {
    if (reg === 0x41) {
      if (value !== null) this.intEnable = value & 0x1f;
      return this.intEnable;
    }
    if (reg === 0x46) return this.intFlags | (this.irqAsserted ? 0x01 : 0) | (this.adb.mouseButton ? 0x80 : 0);
    if (reg === 0x47) this.intFlags = 0;
    return 0;
  }

  /** $C02E-$C02F: the vertical count runs $FA-$1FF (line 0 is $100), the horizontal $00 then $40-$7F. */
  private get verticalCount(): number {
    const { line } = this.video.beam(this.now);
    return line < 0x100 ? 0x100 + line : 0xfa + line - 0x100;
  }

  private get horizontalCount(): number {
    const { h } = this.video.beam(this.now);
    return h === 0 ? 0 : 0x3f + h;
  }

  /** $C068, STATEREG: the memory switches in one byte. */
  private get stateReg(): number {
    const m = this.memory;
    return (
      (m.altZp ? 0x80 : 0) |
      (this.videoSwitches.page2 ? 0x40 : 0) |
      (m.ramRd ? 0x20 : 0) |
      (m.ramWrt ? 0x10 : 0) |
      (m.lcReadRam ? 0 : 0x08) |
      (m.lcBank2 ? 0x04 : 0) |
      (m.intCxRom ? 0x01 : 0)
    );
  }

  private setStateReg(value: number): void {
    const m = this.memory;
    this.video.catchUp(this.now);
    m.altZp = (value & 0x80) !== 0;
    this.videoSwitches.page2 = (value & 0x40) !== 0;
    m.ramRd = (value & 0x20) !== 0;
    m.ramWrt = (value & 0x10) !== 0;
    m.lcReadRam = (value & 0x08) === 0;
    m.lcBank2 = (value & 0x04) !== 0;
    m.intCxRom = (value & 0x01) !== 0;
    this.updatePages();
  }

  /** $C000-$C00F, written. */
  private memorySwitch(reg: number): void {
    const on = (reg & 1) === 1;
    const m = this.memory;
    const v = this.videoSwitches;
    switch (reg >> 1) {
      case 0: v.store80 = on; break;
      case 1: m.ramRd = on; break;
      case 2: m.ramWrt = on; break;
      case 3: m.intCxRom = on; break;
      case 4: m.altZp = on; break;
      case 5: m.slotC3Rom = on; break;
      case 6:
        this.video.catchUp(this.now);
        v.col80 = on;
        break;
      default:
        this.video.catchUp(this.now);
        v.altChar = on;
        break;
    }
    this.updatePages();
  }

  /** $C050-$C05F, read or written. */
  private displaySwitch(reg: number): void {
    this.video.catchUp(this.now);
    const on = (reg & 1) === 1;
    const v = this.videoSwitches;
    switch ((reg >> 1) & 7) {
      case 0: v.text = on; break;
      case 1: v.mixed = on; break;
      case 2:
        v.page2 = on;
        if (v.store80) this.updatePages();
        break;
      case 3:
        v.hires = on;
        if (v.store80) this.updatePages();
        break;
      case 7: v.dhires = !on; break;
      // Annunciators 0-2 go to the game port; nothing here listens.
    }
  }

  /** $C060-$C067: the pushbuttons (the Command and Option keys too) and paddle timers. */
  private gamePort(index: number): number {
    if (index === 0) return 0;
    if (index < 4) {
      const key = index === 1 ? Modifier.Command : index === 2 ? Modifier.Option : 0;
      return this.buttons[index - 1] || this.adb.modifiers & key ? 0x80 : 0;
    }
    const timeout = this.paddleTriggered + this.paddles[index - 4] * PADDLE_CYCLES_PER_UNIT;
    return this.now < timeout ? 0x80 : 0;
  }

  /**
   * $C080-$C08F: bit 3 picks the $D000 bank, bits 0-1 whether reads come
   * from RAM or ROM and whether RAM can be written. Writing needs two reads
   * in a row of an odd address.
   */
  private languageCard(reg: number, isWrite: boolean): void {
    const m = this.memory;
    m.lcBank2 = (reg & 0x08) === 0;
    const mode = reg & 0x03;
    m.lcReadRam = mode === 0 || mode === 3;
    if (mode & 1) {
      if (isWrite) {
        m.lcPrewrite = false;
      } else {
        if (m.lcPrewrite) m.lcWrite = true;
        m.lcPrewrite = true;
      }
    } else {
      m.lcWrite = false;
      m.lcPrewrite = false;
    }
    this.updatePages();
  }

  // --- Inputs and media ------------------------------------------------------------

  /** Types text, each key as soon as the program has taken the last one. */
  typeKeys(text: string): void {
    this.keyQueue.push(...[...text].map((char) => (char === '\n' ? 0x0d : char.charCodeAt(0))));
  }

  insertDisk(drive: number, disk: FloppyDisk | null): void {
    this.disk2.drives[drive].disk = disk;
  }
}
