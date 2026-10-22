import { CYLINDERS, type Disk35 } from './disk35';

/** The tachometer pulses 60 times a revolution. */
const TACH_PULSES = 60;

/**
 * The drive's registers, by CA2 CA1 CA0 SEL (the IWM's phases 2, 1 and 0
 * and the head-select line). Read through the sense line, most are 0 for yes.
 */
const enum Status {
  /** Stepping towards track 0 (1) or the centre (0). */
  Direction = 0b0000,
  NoDisk = 0b0001,
  NotStepping = 0b0010,
  NotWriteProtected = 0b0011,
  MotorOff = 0b0100,
  NotTrack0 = 0b0101,
  Switched = 0b0110,
  /** Reading these makes the lower or upper head the one that reads and writes. */
  LowerHead = 0b1000,
  UpperHead = 0b1001,
  /** Two registers ROM 3 reads, whose purpose isn't known; these are what the drive answers. */
  Rom3Query1 = 0b1010,
  Rom3Query2 = 0b0111,
  DoubleSided = 0b1100,
  NotReady = 0b1101,
  Tachometer = 0b1110,
  NotInstalled = 0b1111,
}

/** Commands, strobed by phase 3: CA1 CA0 SEL pick one, CA2 is its argument. */
const enum Command {
  Direction = 0b000,
  ClearSwitched = 0b001,
  Step = 0b010,
  Motor = 0b100,
  Eject = 0b110,
}

/**
 * The Apple 3.5 Drive (Sony's double-sided 800K mechanism, as in the
 * Macintosh): it has no controller of its own, so the computer steps the
 * head, turns the motor on and off and ejects the disk by commands, reads
 * its state one bit at a time (reading one of two registers also picks the
 * head), and reads and writes the tracks' GCR bits
 * through the IWM. Each zone of 16 cylinders turns at its own speed, so a
 * bit takes 2 µs everywhere.
 */
export class Drive35 {
  disk: Disk35 | null = null;
  cylinder = 0;
  /** Stepping towards track 0. */
  outward = false;
  motorOn = false;
  /** A disk was inserted since the computer last cleared this. */
  switched = false;
  /** The head reading and writing: 0 (lower) or 1 (upper). */
  head = 0;
  /** Bit under the head on the current track. */
  bitPosition = 0;

  /** The register picked by `select` (CA2 CA1 CA0 SEL), as the sense line reads it. */
  sense(select: number): boolean {
    switch (select) {
      case Status.Direction: return this.outward;
      case Status.NoDisk: return this.disk === null;
      case Status.NotStepping: return true;
      case Status.NotWriteProtected: return !(this.disk?.writeProtected ?? false);
      case Status.MotorOff: return !this.motorOn;
      case Status.NotTrack0: return this.cylinder !== 0;
      case Status.Switched: return false;
      case Status.LowerHead:
      case Status.UpperHead:
        this.head = select & 1;
        return false;
      case Status.Rom3Query1: return true;
      case Status.Rom3Query2: return false;
      case Status.DoubleSided: return true;
      case Status.NotReady: return !(this.motorOn && this.disk !== null);
      case Status.Tachometer: return this.tachometer();
      default: return false;
    }
  }

  /** A command strobed in: `select` is CA1 CA0 SEL and `argument` CA2. */
  command(select: number, argument: boolean): void {
    switch (select) {
      case Command.Direction: this.outward = argument; break;
      case Command.ClearSwitched: if (argument) this.switched = false; break;
      case Command.Step:
        this.cylinder = Math.max(0, Math.min(CYLINDERS - 1, this.cylinder + (this.outward ? -1 : 1)));
        break;
      case Command.Motor: this.motorOn = !argument; break;
      case Command.Eject:
        if (argument) this.disk = null;
        break;
    }
  }

  /** The track under the active head, or null without a disk. */
  track(): Uint8Array | null {
    return this.disk?.track(this.cylinder, this.head) ?? null;
  }

  insert(disk: Disk35 | null): void {
    this.disk = disk;
    this.switched = disk !== null;
  }

  private tachometer(): boolean {
    const length = this.track()?.length ?? 1;
    return Math.floor((this.bitPosition * TACH_PULSES * 2) / length) % 2 === 1;
  }
}
