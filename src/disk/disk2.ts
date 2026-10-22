import { Drive35 } from './drive35';
import type { FloppyDisk } from './floppy';

const QUARTER_TRACKS = 160;
/** The motor keeps turning this long after it is switched off (the controller's one-shot). */
const MOTOR_OFF_DELAY = 1_020_484;
/** The drive counts as busy for this long after the last access while the motor turns. */
const BUSY_WINDOW = 60_000;
/**
 * After this many cells without a flux transition the read amplifier starts
 * picking up noise, which reads as random bits (as the WOZ spec describes).
 */
const MAX_QUIET_CELLS = 3;
/** IWM mode bit 2: the motor stops at once, without the one-second delay. */
const IWM_IMMEDIATE_OFF = 0x04;
/** IWM mode bit 1: asynchronous handshake (reading a byte empties the data register). */
const IWM_ASYNC = 0x02;
/** IWM mode bit 3: 2 µs bit cells (the 3.5" drives) rather than 4. */
const IWM_FAST = 0x08;
/** Phase 3 is the 3.5" drive's command strobe. */
const LSTRB = 0x08;
/**
 * Phases 1 and 3 on together enable the SmartPort bus: 5.25" drives let go
 * of the sense line, which reads high unless a SmartPort device answers.
 */
const SMARTPORT_ENABLE = 0b1010;
/** Without a new byte, the IWM's data and shift registers are empty after two bytes' time: an underrun. */
const UNDERRUN_CYCLES = 64;
/** A complete byte stays in the latch for at least this many further bit cells. */
const LATCH_HOLD_CELLS = 2;
/** Catching up after a long gap: beyond this many revolutions, the bits in between can't matter. */
const MAX_CATCH_UP_REVOLUTIONS = 2;

export class DiskDrive {
  disk: FloppyDisk | null = null;
  /** Head position in quarter tracks (0-159; track n is at 4n). */
  quarterTrack = 0;
  /** Bit under the head on the current track. */
  bitPosition = 0;
}

/**
 * The Disk II controller card and its two drives. The CPU drives the stepper
 * magnets, the motor and the read/write logic through 16 soft switches; the
 * logic state sequencer is modelled as a shift register clocked once per bit
 * cell, which reads bits into the data latch (a byte starts with its first 1
 * bit) or writes the latch's top bit out, so every disk is read bit by bit as
 * the real controller does.
 *
 * The IIgs's IWM chip does the same in its Disk II mode, and adds a mode
 * register (written with the motor off and Q6 and Q7 on), a status register
 * and a write handshake register, which the IIgs's firmware checks.
 */
export class Disk2 {
  readonly drives = [new DiskDrive(), new DiskDrive()];
  phases = 0;
  motorOn = false;
  /** While the motor is switched off but still turning: the cycle it stops. */
  motorStopsAt = 0;
  selected = 0;
  q6 = false;
  q7 = false;
  latch = 0;
  /** Cycle up to which the disk has turned. */
  lastCycle = 0;
  /** Cycles into the current bit cell. */
  cellPhase = 0;
  lastAccess = -BUSY_WINDOW;
  /** When the CPU last gave the IWM a byte to write. */
  lastDataWrite = -UNDERRUN_CYCLES;
  /** The IIc's IWM: its registers answer as well as the Disk II's. */
  iwm = false;
  /**
   * The IWM is talking to the 3.5" drives (the IIgs's $C031 bit 6): the
   * phases select their registers and strobe commands rather than step a
   * head, and bytes pass through a data register and a separate shift register.
   */
  drive35 = false;
  readonly drives35 = [new Drive35(), new Drive35()];
  /** The SEL line: one bit of the 3.5" drive's register select. */
  headSelect = false;
  /** The 3.5" data register (read), and the shift register filling it. */
  latch35 = 0;
  shifter35 = 0;
  /** Writing to a 3.5" disk: the byte waiting in the data register, and the one being shifted out. */
  writeBuffer: number | null = null;
  writeShift = 0;
  writeBits = 0;
  underrun = false;
  /** The IWM's mode register (5 bits). */
  mode = 0;
  /** Bits read since a complete byte arrived in the latch, held until the byte has been readable for a while. */
  private heldBits = 0;
  private heldCount = 0;
  private holding = -1;
  private quietCells = 0;
  private noise = 0x1234;

  constructor(readonly rom: Uint8Array) {}

  get drive(): DiskDrive {
    return this.drives[this.selected];
  }

  spinning(cycle: number): boolean {
    return this.motorOn || cycle < this.motorStopsAt;
  }

  /** The motor is turning and the drive was accessed recently: a disk is being read or written. */
  busy(cycle: number): boolean {
    return this.spinning(cycle) && this.drive.disk !== null && cycle - this.lastAccess < BUSY_WINDOW;
  }

  reset(): void {
    this.phases = 0;
    this.motorOn = false;
    this.motorStopsAt = 0;
    this.q6 = this.q7 = false;
  }

  /** An access to $C0n0-$C0nF: `value` is what the CPU wrote, or null for a read. */
  access(offset: number, value: number | null, cycle: number): number {
    if (this.drive35) this.turn35(cycle);
    else this.turn(cycle);
    this.lastAccess = cycle;
    if (offset < 8) {
      const phase = offset >> 1;
      const before = this.phases;
      if (offset & 1) this.phases |= 1 << phase;
      else this.phases &= ~(1 << phase);
      if (this.drive35) this.strobe35(before, cycle);
      else if (this.spinning(cycle)) this.step();
    } else {
      switch (offset) {
        case 0x8:
          if (this.motorOn) this.motorStopsAt = this.iwm && this.mode & IWM_IMMEDIATE_OFF ? cycle : cycle + MOTOR_OFF_DELAY;
          this.motorOn = false;
          break;
        case 0x9:
          this.motorOn = true;
          break;
        case 0xa:
        case 0xb:
          this.selected = offset & 1;
          break;
        case 0xc:
          this.q6 = false;
          break;
        case 0xd:
          this.q6 = true;
          break;
        case 0xe:
          this.q7 = false;
          break;
        case 0xf:
          if (!this.q7) this.startWriting35();
          this.q7 = true;
          break;
      }
    }
    const writeProtected = this.drive.disk?.writeProtected ?? false;
    if (this.iwm && value !== null && this.q6 && this.q7 && offset & 1 && !this.spinning(cycle)) {
      this.mode = value & 0x1f;
      return 0;
    }
    // Writing in load mode (Q6 and Q7 on) puts the byte in the shift register to be written.
    if (value !== null && this.q6 && this.q7) {
      if (this.drive35) this.writeBuffer = value;
      else this.latch = value;
      this.lastDataWrite = cycle;
    }
    if (offset & 1) return 0;
    if (this.iwm && this.q6 && !this.q7) {
      const senseHigh = this.drive35
        ? this.sense35(cycle)
        : writeProtected || (this.phases & SMARTPORT_ENABLE) === SMARTPORT_ENABLE;
      return (senseHigh ? 0x80 : 0) | (this.spinning(cycle) ? 0x20 : 0) | this.mode;
    }
    if (this.iwm && !this.q6 && this.q7) {
      // The write handshake: bit 7 when the data register can take a byte, bit 6 until an underrun.
      if (this.drive35) return (this.writeBuffer === null ? 0x80 : 0) | (this.underrun ? 0 : 0x40) | 0x3f;
      return cycle - this.lastDataWrite < UNDERRUN_CYCLES ? 0xff : 0xbf;
    }
    // Sensing write protect (Q6 on, Q7 off) reads the switch into the top bit.
    if (this.q6 && !this.q7) return writeProtected ? 0xff : 0x00;
    if (this.drive35) return this.readData35();
    return this.latch;
  }

  // --- The 3.5" drives ------------------------------------------------------------------

  get drive35Selected(): Drive35 {
    return this.drives35[this.selected];
  }

  /** The selected 3.5" drive's register on the sense line; with the drive not enabled, the line floats high. */
  private sense35(cycle: number): boolean {
    if (!this.spinning(cycle)) return true;
    return this.drive35Selected.sense(((this.phases & 7) << 1) | (this.headSelect ? 1 : 0));
  }

  /** Phase 3 going on strobes a command into the enabled drive. */
  private strobe35(before: number, cycle: number): void {
    if (before & LSTRB || !(this.phases & LSTRB) || !this.spinning(cycle)) return;
    this.drive35Selected.command(((this.phases & 3) << 1) | (this.headSelect ? 1 : 0), (this.phases & 4) !== 0);
  }

  private startWriting35(): void {
    this.writeBuffer = null;
    this.writeBits = 0;
    this.underrun = false;
  }

  /** In asynchronous mode, reading a complete byte empties the data register. */
  private readData35(): number {
    const value = this.latch35;
    if (value & 0x80 && this.mode & IWM_ASYNC) this.latch35 = 0;
    return value;
  }

  /** Turns the selected 3.5" disk up to `cycle`, reading bits into the data register or writing them. */
  private turn35(cycle: number): void {
    const elapsed = cycle - this.lastCycle;
    this.lastCycle = cycle;
    const drive = this.drive35Selected;
    if (elapsed <= 0 || !this.spinning(cycle) || !drive.motorOn) return;
    const cyclesPerBit = this.mode & IWM_FAST ? 2 : 4;
    this.cellPhase += elapsed;
    let cells = Math.floor(this.cellPhase / cyclesPerBit);
    this.cellPhase -= cells * cyclesPerBit;
    const track = drive.track();
    if (cells === 0 || track === null) return;
    const length = track.length;
    const limit = length * MAX_CATCH_UP_REVOLUTIONS;
    if (cells > limit) {
      drive.bitPosition = (drive.bitPosition + cells - limit) % length;
      cells = limit;
    }
    const disk = drive.disk!;
    for (let i = 0; i < cells; i++) {
      if (drive.bitPosition >= length) drive.bitPosition = 0;
      if (this.q7) {
        if (this.writeBits === 0) {
          if (this.writeBuffer === null) this.underrun = true;
          else {
            this.writeShift = this.writeBuffer;
            this.writeBuffer = null;
            this.writeBits = 8;
          }
        }
        if (this.writeBits > 0 && !disk.writeProtected) {
          track[drive.bitPosition] = (this.writeShift >> 7) & 1;
          this.writeShift = (this.writeShift << 1) & 0xff;
          this.writeBits--;
          disk.dirty = true;
        }
      } else {
        const bit = track[drive.bitPosition];
        if (this.shifter35 !== 0 || bit) {
          this.shifter35 = ((this.shifter35 << 1) | bit) & 0xff;
          if (this.shifter35 & 0x80) {
            this.latch35 = this.shifter35;
            this.shifter35 = 0;
          }
        }
      }
      drive.bitPosition++;
    }
  }

  /** Moves the head of the selected drive towards the energised magnets. */
  private step(): void {
    const drive = this.drive;
    let sum = 0;
    let count = 0;
    for (let magnet = 0; magnet < 4; magnet++) {
      if (!(this.phases & (1 << magnet))) continue;
      // Each magnet holds the head at one of every eight quarter tracks.
      const offset = ((((magnet * 2 - drive.quarterTrack) % 8) + 12) % 8) - 4;
      if (offset === -4) continue;
      sum += offset;
      count++;
    }
    if (count === 0) return;
    const before = drive.disk?.trackAt(drive.quarterTrack);
    drive.quarterTrack = Math.max(0, Math.min(QUARTER_TRACKS - 1, drive.quarterTrack + Math.round(sum / count)));
    const after = drive.disk?.trackAt(drive.quarterTrack);
    if (before && after && before !== after) drive.bitPosition = Math.floor((drive.bitPosition * after.length) / before.length);
  }

  private randomBit(): number {
    // A 16-bit LFSR, so runs are repeatable (and save states exact).
    const bit = (this.noise ^ (this.noise >> 2) ^ (this.noise >> 3) ^ (this.noise >> 5)) & 1;
    this.noise = (this.noise >> 1) | (bit << 15);
    return this.noise & 1 && this.noise & 2 ? 1 : 0;
  }

  /** Turns the disk up to `cycle`, reading bits into the latch or writing them. */
  turn(cycle: number): void {
    const elapsed = cycle - this.lastCycle;
    this.lastCycle = cycle;
    if (elapsed <= 0 || !this.spinning(cycle - elapsed)) return;
    const drive = this.drive;
    const disk = drive.disk;
    const cyclesPerBit = (disk?.bitTiming ?? 32) / 8;
    this.cellPhase += Math.min(elapsed, this.spinning(cycle) ? elapsed : this.motorStopsAt - (cycle - elapsed));
    let cells = Math.floor(this.cellPhase / cyclesPerBit);
    this.cellPhase -= cells * cyclesPerBit;
    if (cells === 0) return;
    const track = disk?.trackAt(drive.quarterTrack) ?? null;
    const length = track?.length ?? 51200;
    const limit = length * MAX_CATCH_UP_REVOLUTIONS;
    if (cells > limit) {
      drive.bitPosition = (drive.bitPosition + cells - limit) % length;
      cells = limit;
    }
    const writing = this.q7 && disk !== null && !disk.writeProtected && track !== null;
    for (let i = 0; i < cells; i++) {
      if (writing) {
        track[drive.bitPosition] = this.latch >> 7;
        this.latch = (this.latch << 1) & 0xff;
        disk.dirty = true;
      } else if (!this.q7) {
        this.readBit(track ? track[drive.bitPosition] : this.randomBit());
      }
      if (++drive.bitPosition >= length) drive.bitPosition = 0;
    }
  }

  private readBit(flux: number): void {
    let bit = flux;
    if (bit) this.quietCells = 0;
    else if (++this.quietCells > MAX_QUIET_CELLS) bit = this.randomBit();
    if (this.holding >= 0) {
      this.heldBits = (this.heldBits << 1) | bit;
      this.heldCount++;
      if (++this.holding < LATCH_HOLD_CELLS) return;
      // The byte has been readable long enough: start the next one with the bits that arrived meanwhile.
      this.holding = -1;
      this.latch = 0;
      const bits = this.heldBits;
      const count = this.heldCount;
      this.heldBits = this.heldCount = 0;
      for (let i = count - 1; i >= 0; i--) this.shiftIn((bits >> i) & 1);
      return;
    }
    this.shiftIn(bit);
  }

  private shiftIn(bit: number): void {
    if (this.latch === 0 && bit === 0) return;
    this.latch = ((this.latch << 1) | bit) & 0xff;
    if (this.latch & 0x80) this.holding = 0;
  }
}
