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
   * The IIgs's $C031 has switched the IWM to the 3.5" drives, of which there
   * are none: the phases select their registers rather than step a head, and
   * the sense line reads high (no drive).
   */
  drive35 = false;
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
    this.turn(cycle);
    this.lastAccess = cycle;
    if (offset < 8) {
      const phase = offset >> 1;
      if (offset & 1) this.phases |= 1 << phase;
      else this.phases &= ~(1 << phase);
      if (this.spinning(cycle) && !this.drive35) this.step();
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
      this.latch = value;
      this.lastDataWrite = cycle;
    }
    if (offset & 1) return 0;
    if (this.iwm && this.q6 && !this.q7) {
      const senseHigh = writeProtected || this.drive35 || (this.phases & SMARTPORT_ENABLE) === SMARTPORT_ENABLE;
      return (senseHigh ? 0x80 : 0) | (this.spinning(cycle) ? 0x20 : 0) | this.mode;
    }
    // The IWM's write handshake: always ready for the next byte; bit 6 clears once the last one has gone out.
    if (this.iwm && !this.q6 && this.q7) return cycle - this.lastDataWrite < UNDERRUN_CYCLES ? 0xff : 0xbf;
    // Sensing write protect (Q6 on, Q7 off) reads the switch into the top bit.
    if (this.q6 && !this.q7) return writeProtected ? 0xff : 0x00;
    return this.latch;
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
    if (this.drive35) return;
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
