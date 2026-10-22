import { Doc5503 } from './doc5503';

const CONTROL_RAM = 0x40;
const CONTROL_AUTO_INCREMENT = 0x20;

/**
 * The sound GLU, through which the CPU reaches the Ensoniq DOC's registers
 * and its 64K of sound RAM: $C03C picks which (and auto-increment and the
 * volume), $C03E-$C03F hold the address and $C03D the data. A read of $C03D
 * returns the byte fetched by the read before it.
 */
export class SoundGlu {
  readonly ram = new Uint8Array(0x10000);
  readonly doc: Doc5503;
  control = 0;
  address = 0;
  private latch = 0;

  constructor(megaHz: number) {
    this.doc = new Doc5503(this.ram, megaHz);
  }

  read(reg: number): number {
    switch (reg) {
      case 0x3c: return this.control & 0x7f;
      case 0x3d: {
        const value = this.latch;
        this.latch = this.control & CONTROL_RAM ? this.ram[this.address] : this.doc.read(this.address & 0xff);
        this.advance();
        return value;
      }
      case 0x3e: return this.address & 0xff;
      default: return this.address >> 8;
    }
  }

  write(reg: number, value: number): void {
    switch (reg) {
      case 0x3c: this.control = value; break;
      case 0x3d:
        if (this.control & CONTROL_RAM) this.ram[this.address] = value;
        else this.doc.write(this.address & 0xff, value);
        this.advance();
        break;
      case 0x3e: this.address = (this.address & 0xff00) | value; break;
      default: this.address = (this.address & 0xff) | (value << 8); break;
    }
  }

  /** The master volume, 0-15. */
  get volume(): number {
    return this.control & 0x0f;
  }

  private advance(): void {
    if (this.control & CONTROL_AUTO_INCREMENT) this.address = (this.address + 1) & 0xffff;
  }
}
