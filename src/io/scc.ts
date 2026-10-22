/** RR0: the transmit buffer is empty, and CTS and DCD are up. */
const RR0_IDLE = 0x2c;
/** RR1: everything has been sent. */
const RR1_ALL_SENT = 0x01;

/**
 * The Z8530 serial chip behind the printer and modem ports ($C038-$C03B).
 * Nothing is plugged in: the firmware can set up both channels (a command
 * write picks a register, the next writes it) and always finds them idle.
 */
export class Scc {
  private readonly pointers = [0, 0];
  private readonly registers = [new Uint8Array(16), new Uint8Array(16)];

  /** $C038 and $C039 are channel B's and A's commands; $C03A and $C03B their data. */
  read(reg: number): number {
    const channel = reg & 1;
    if (reg >= 0x3a) return 0;
    const pointer = this.pointers[channel];
    this.pointers[channel] = 0;
    if (pointer === 0) return RR0_IDLE;
    if (pointer === 1) return RR1_ALL_SENT;
    // RR2 and RR12-13 read back what was written (the vector and baud rate).
    return pointer === 2 || pointer >= 12 ? this.registers[channel][pointer] : 0;
  }

  write(reg: number, value: number): void {
    if (reg >= 0x3a) return;
    const channel = reg & 1;
    const pointer = this.pointers[channel];
    if (pointer === 0) {
      // WR0: the low bits pick the next register; command 1 ("point high") adds 8.
      const next = (value & 7) | ((value & 0x38) === 0x08 ? 8 : 0);
      this.pointers[channel] = next;
      return;
    }
    this.registers[channel][pointer] = value;
    // WR2 (the interrupt vector) is shared by both channels.
    if (pointer === 2) this.registers[channel ^ 1][2] = value;
    this.pointers[channel] = 0;
  }

  reset(): void {
    this.pointers.fill(0);
  }
}
