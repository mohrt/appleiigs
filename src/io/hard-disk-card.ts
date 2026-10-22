import { BLOCK_BYTES } from '../disk/disk35';
import type { HardDisk } from '../disk/hard-disk';

/** What the card reaches in the IIgs: bank $00 as the CPU sees it, and the CPU's registers. */
export interface CardHost {
  peek(addr: number): number;
  poke(addr: number, value: number): void;
  readonly cpu: { s: number; x: number; y: number };
}

/** ProDOS and SmartPort error codes. */
const enum Result {
  None = 0x00,
  BadCommand = 0x01,
  BadUnit = 0x11,
  BadStatusCode = 0x21,
  IoError = 0x27,
  NoDevice = 0x28,
  WriteProtected = 0x2b,
  Offline = 0x2f,
}

/** The card's I/O: a ProDOS call, the result, and a SmartPort call. */
const PRODOS_CALL = 0x0;
const RESULT = 0x1;
const SMARTPORT_CALL = 0x2;
const PRODOS_ENTRY = 0x40;
/**
 * $Cn07: not $00, so ProDOS takes it as a plain block device rather than a
 * SmartPort (whose extra units ProDOS 8 would also install). It says it has
 * two volumes, as ProDOS's start-up expects of the device it starts from;
 * the second answers that there's no disk.
 */
const BLOCK_DEVICE_ID = 0x01;

/**
 * The card's 256 bytes of firmware. The first eight bytes carry the ProDOS
 * block device signature; booting reads block 0 into $0800 and runs it. The
 * ProDOS entry point ($Cn40, named at $CnFF) and a SmartPort one three bytes
 * on (for software that calls it anyway) each store to the card's I/O, which
 * does the call, then load the error code and set the carry if there was one.
 */
function firmware(slot: number): Uint8Array {
  const rom = new Uint8Array(0x100);
  const page = 0xc0 + slot;
  const io = 0x80 + slot * 0x10;
  const unit = slot << 4;
  rom.set([0xa2, 0x20, 0xa0, 0x00, 0xa2, 0x03, 0xa2, BLOCK_DEVICE_ID], 0x00);
  // prettier-ignore
  rom.set([
    0xa9, 0x01, 0x85, 0x42, // LDA #1 (read), STA $42
    0xa9, unit, 0x85, 0x43, // the unit: this slot, drive 1
    0xa9, 0x00, 0x85, 0x44, 0x85, 0x46, 0x85, 0x47, // buffer $0800, block 0
    0xa9, 0x08, 0x85, 0x45,
    0x20, PRODOS_ENTRY, page, // JSR the ProDOS entry
    0xb0, 0x0a, // BCS: unreadable, so on to the next slot
    0xad, 0x00, 0x08, 0xf0, 0x05, // LDA $0800, BEQ: no boot block (a data disk), so on to the next slot
    0xa2, unit, 0x4c, 0x01, 0x08, // LDX #slot*16, JMP $0801
    0x4c, 0xba, 0xfa, // JMP $FABA: the Monitor's slot scan goes on from the slot below
  ], 0x08);
  // prettier-ignore
  rom.set([
    0x4c, 0x50, page, // ProDOS: JMP $Cn50
    0x8d, io + SMARTPORT_CALL, 0xc0, 0xad, io + RESULT, 0xc0, 0xc9, 0x01, 0x60, // SmartPort: STA, LDA result, CMP #1, RTS
  ], PRODOS_ENTRY);
  rom.set([0x8d, io + PRODOS_CALL, 0xc0, 0xad, io + RESULT, 0xc0, 0xc9, 0x01, 0x60], 0x50);
  // $CnFB: no extended SmartPort calls; $CnFC-FD: ask STATUS for the size; $CnFE: two volumes, with status, read, write and format; $CnFF: the entry.
  rom.set([0x00, 0x00, 0x00, 0x1f, PRODOS_ENTRY], 0xfb);
  return rom;
}

/**
 * A hard disk card (slot 7 by default) whose firmware, written for this
 * emulator, answers ProDOS and SmartPort calls by handing them to the
 * emulator, which moves the blocks itself: ProDOS 8 and GS/OS both start
 * from it and use it.
 */
export class HardDiskCard {
  disk: HardDisk | null = null;
  readonly rom: Uint8Array;
  private result = 0;

  constructor(
    private readonly host: CardHost,
    readonly slot = 7,
  ) {
    this.rom = firmware(slot);
  }

  /** $C0n0-$C0nF, read (`value` null) or written. */
  io(reg: number, value: number | null): number {
    if (value === null) return reg === RESULT ? this.result : 0;
    if (reg === PRODOS_CALL) this.result = this.prodosCall();
    else if (reg === SMARTPORT_CALL) this.result = this.smartPortCall();
    return 0;
  }

  private peek16(addr: number): number {
    return this.host.peek(addr & 0xffff) | (this.host.peek((addr + 1) & 0xffff) << 8);
  }

  /** ProDOS's block driver call: command in $42, unit in $43, buffer at $44-$45, block at $46-$47. */
  private prodosCall(): number {
    const host = this.host;
    const command = host.peek(0x42);
    if (host.peek(0x43) & 0x80) return Result.NoDevice;
    const buffer = this.peek16(0x44);
    const block = this.peek16(0x46);
    if (command === 0) {
      if (!this.disk) return Result.Offline;
      host.cpu.x = this.disk.blocks & 0xff;
      host.cpu.y = this.disk.blocks >> 8;
      return Result.None;
    }
    if (command === 1) return this.readBlock(block, buffer);
    if (command === 2) return this.writeBlock(block, buffer);
    return command === 3 ? Result.None : Result.BadCommand;
  }

  /** A SmartPort call: the command and its parameter list's address follow the JSR, which returns past them. */
  private smartPortCall(): number {
    const host = this.host;
    const stack = (host.cpu.s + 1) & 0xffff;
    const returnAddr = this.peek16(stack);
    const command = host.peek((returnAddr + 1) & 0xffff);
    const list = this.peek16(returnAddr + 2);
    const next = (returnAddr + 3) & 0xffff;
    host.poke(stack, next & 0xff);
    host.poke((stack + 1) & 0xffff, next >> 8);
    // Extended calls (with 32-bit addresses) aren't offered: $CnFB says so.
    if (command & 0x40) return Result.BadCommand;
    const unit = host.peek((list + 1) & 0xffff);
    const buffer = this.peek16(list + 2);
    if (command === 0) return this.status(unit, buffer, host.peek((list + 4) & 0xffff));
    if (unit !== 1) return unit === 0 ? Result.BadUnit : Result.NoDevice;
    const block = this.peek16(list + 4) | (host.peek((list + 6) & 0xffff) << 16);
    switch (command) {
      case 1: return this.readBlock(block, buffer);
      case 2: return this.writeBlock(block, buffer);
      case 3: case 4: case 5: return Result.None;
      default: return Result.BadCommand;
    }
  }

  /** SmartPort STATUS: of the card (unit 0) or the disk: its state and size, or its device information block. */
  private status(unit: number, buffer: number, code: number): number {
    const reply = (bytes: number[]) => {
      bytes.forEach((byte, i) => this.host.poke((buffer + i) & 0xffff, byte));
      this.host.cpu.x = bytes.length & 0xff;
      this.host.cpu.y = bytes.length >> 8;
      return Result.None;
    };
    if (unit === 0) return code === 0 ? reply([1, 0, 0, 0, 0, 0, 0, 0]) : Result.BadStatusCode;
    if (unit !== 1) return Result.NoDevice;
    const blocks = this.disk?.blocks ?? 0;
    // Block device, readable, online and formattable; writable unless protected.
    const state = this.disk ? (this.disk.writeProtected ? 0xb4 : 0xf8) : 0xe8;
    const general = [state, blocks & 0xff, (blocks >> 8) & 0xff, blocks >> 16];
    if (code === 0) return reply(general);
    if (code === 3) {
      const name = 'HARD DISK'.padEnd(16, ' ');
      return reply([...general, 9, ...[...name].map((char) => char.charCodeAt(0)), 0x02, 0x00, 0x01, 0x00]);
    }
    return Result.BadStatusCode;
  }

  private readBlock(block: number, buffer: number): number {
    if (!this.disk) return Result.Offline;
    if (block >= this.disk.blocks) return Result.IoError;
    const data = this.disk.block(block);
    for (let i = 0; i < BLOCK_BYTES; i++) this.host.poke((buffer + i) & 0xffff, data[i]);
    return Result.None;
  }

  private writeBlock(block: number, buffer: number): number {
    if (!this.disk) return Result.Offline;
    if (this.disk.writeProtected) return Result.WriteProtected;
    if (block >= this.disk.blocks) return Result.IoError;
    const data = this.disk.block(block);
    for (let i = 0; i < BLOCK_BYTES; i++) data[i] = this.host.peek((buffer + i) & 0xffff);
    this.disk.dirty = true;
    return Result.None;
  }
}
