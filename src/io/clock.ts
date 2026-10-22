/** Seconds from the clock's epoch (1 January 1904) to the Unix epoch. */
const EPOCH_1904 = 2_082_844_800;

const enum Phase {
  Command,
  /** An extended command's second byte: the rest of the battery RAM address. */
  Address,
  Data,
}

const enum Target {
  Seconds,
  Ram,
  /** The test and write-protect registers. */
  Internal,
}

/**
 * The real-time clock chip with its 256 bytes of battery RAM, the same chip
 * the Mac uses. The CPU puts a byte in $C033 and starts a transfer through
 * $C034 (bit 7, with bit 6 set to read); each transfer here finishes at once.
 * A command names the seconds counter (four bytes) or a battery RAM address,
 * then a second transfer reads or writes the byte. The time is the host's
 * local time.
 */
export class Clock {
  /** The battery RAM: the Control Panel's settings, checked by the ROM against their checksum. */
  readonly bram = new Uint8Array(256);
  /** $C033. */
  data = 0;
  /** $C034's control bits (5-7); its low nibble is the border colour, kept with the video. */
  control = 0;
  /** Seconds the set time is ahead of the host's. */
  offset = 0;
  writeProtected = false;
  private phase = Phase.Command;
  private target = Target.Seconds;
  private address = 0;

  /** A write to $C034 with bit 7 set: the transfer happens and bit 7 clears. */
  transfer(control: number): void {
    this.control = control & 0x60;
    const read = (control & 0x40) !== 0;
    if (this.phase === Phase.Command) this.command(this.data);
    else if (this.phase === Phase.Address) {
      this.address |= (this.data >> 2) & 0x1f;
      this.phase = Phase.Data;
    } else {
      if (read) this.data = this.readTarget();
      else this.writeTarget(this.data);
      this.phase = Phase.Command;
    }
  }

  /** The first byte; its top bit (read or write) is repeated in the data transfer's $C034 bit 6. */
  private command(byte: number): void {
    this.phase = Phase.Data;
    if ((byte & 0x78) === 0x38) {
      // z0111abc then defgh00: battery RAM address abcdefgh.
      this.target = Target.Ram;
      this.address = (byte & 7) << 5;
      this.phase = Phase.Address;
    } else if (byte & 0x40) {
      // z1abcd01: battery RAM address 0abcd.
      this.target = Target.Ram;
      this.address = (byte >> 2) & 0x0f;
    } else if ((byte & 0x70) === 0x20) {
      // z010ab01: battery RAM address 100ab.
      this.target = Target.Ram;
      this.address = 0x10 | ((byte >> 2) & 3);
    } else if ((byte & 0x70) === 0x30) {
      this.target = Target.Internal;
      this.address = (byte >> 2) & 1;
    } else {
      // z000ab01: byte ab of the seconds counter.
      this.target = Target.Seconds;
      this.address = (byte >> 2) & 3;
    }
  }

  private get seconds(): number {
    const now = new Date();
    return (Math.floor(now.getTime() / 1000) - now.getTimezoneOffset() * 60 + EPOCH_1904 + this.offset) >>> 0;
  }

  private readTarget(): number {
    if (this.target === Target.Ram) return this.bram[this.address];
    if (this.target === Target.Seconds) return (this.seconds >>> (this.address * 8)) & 0xff;
    return 0;
  }

  private writeTarget(value: number): void {
    if (this.target === Target.Internal) {
      if (this.address === 1) this.writeProtected = (value & 0x80) !== 0;
      return;
    }
    if (this.writeProtected) return;
    if (this.target === Target.Ram) {
      this.bram[this.address] = value;
      return;
    }
    const shift = this.address * 8;
    const wanted = ((this.seconds & ~(0xff << shift)) | (value << shift)) >>> 0;
    this.offset += wanted - this.seconds;
  }

  reset(): void {
    this.phase = Phase.Command;
    this.control = 0;
  }
}
