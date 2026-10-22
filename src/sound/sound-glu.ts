const CONTROL_RAM = 0x40;
const CONTROL_AUTO_INCREMENT = 0x20;
/** The DOC's oscillator interrupt register: bit 7 clear while an oscillator's interrupt is waiting. */
const DOC_OIR = 0xe0;
const OIR_NONE = 0x80;

/**
 * The sound GLU, through which the CPU reaches the Ensoniq DOC's registers
 * and its 64K of sound RAM: $C03C picks which (and auto-increment and the
 * volume), $C03E-$C03F hold the address and $C03D the data. A read of $C03D
 * returns the byte fetched by the read before it.
 */
export class SoundGlu {
  readonly ram = new Uint8Array(0x10000);
  readonly docRegisters = new Uint8Array(256);
  control = 0;
  address = 0;
  private latch = 0;

  read(reg: number): number {
    switch (reg) {
      case 0x3c: return this.control & 0x7f;
      case 0x3d: {
        const value = this.latch;
        this.latch = this.control & CONTROL_RAM ? this.ram[this.address] : this.readDoc(this.address & 0xff);
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
        else this.docRegisters[this.address & 0xff] = value;
        this.advance();
        break;
      case 0x3e: this.address = (this.address & 0xff00) | value; break;
      default: this.address = (this.address & 0xff) | (value << 8); break;
    }
  }

  get volume(): number {
    return this.control & 0x0f;
  }

  private readDoc(register: number): number {
    if (register === DOC_OIR) return OIR_NONE;
    return this.docRegisters[register];
  }

  private advance(): void {
    if (this.control & CONTROL_AUTO_INCREMENT) this.address = (this.address + 1) & 0xffff;
  }
}
