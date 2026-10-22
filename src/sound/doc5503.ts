const OSCILLATORS = 32;
/** The DOC's clock is 7.16 MHz / 8; each pass over the enabled oscillators takes their number plus two of its cycles. */
const DOC_HZ = 894_886;
/** In each mode, what an oscillator does at the end of its table. */
const enum Mode {
  FreeRun,
  OneShot,
  Sync,
  Swap,
}
const CONTROL_HALT = 0x01;
const CONTROL_IRQ = 0x08;

/** For each table size (256 bytes to 32K), which bits of the pointer register stay in the address and which bits of the accumulator are used. */
const POINTER_MASKS = [0xff00, 0xfe00, 0xfc00, 0xf800, 0xf000, 0xe000, 0xc000, 0x8000];
const SIZE_MASKS = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

class Oscillator {
  frequency = 0;
  volume = 0;
  /** The last sample read. */
  data = 0x80;
  pointer = 0;
  control = CONTROL_HALT;
  /** $C0-$DF: table size in bits 3-5, resolution in bits 0-2. */
  tableSize = 0;
  accumulator = 0;
  irqPending = false;

  get mode(): Mode {
    return (this.control >> 1) & 3;
  }

  get halted(): boolean {
    return (this.control & CONTROL_HALT) !== 0;
  }
}

/**
 * The Ensoniq 5503 Digital Oscillator Chip: 32 oscillators that play 8-bit
 * samples from its 64K of sound RAM. Each oscillator steps through a table
 * of 256 bytes to 32K at a rate set by its 16-bit frequency, and at the end
 * of the table loops (free run), stops (one-shot) or stops and starts its
 * partner (swap), raising an interrupt if asked to. A zero sample stops it
 * too. Their outputs are scaled by their volumes and summed; the IIgs has
 * one (mono) output.
 */
export class Doc5503 {
  readonly oscillators = Array.from({ length: OSCILLATORS }, () => new Oscillator());
  /** $E1: the number of oscillators enabled, less one, in bits 1-5. */
  enableRegister = 0;
  /** The output (the sum of the oscillators) since the last pass, and when that pass happens. */
  output = 0;
  /** The Mega II cycle the chip has run to. */
  time = 0;
  /** Called with the output and the cycle each pass ends at. */
  onOutput: (level: number, cycle: number) => void = () => {};
  private readonly megaCyclesPerDocCycle: number;

  constructor(
    private readonly ram: Uint8Array,
    megaHz: number,
  ) {
    this.megaCyclesPerDocCycle = megaHz / DOC_HZ;
  }

  get enabledCount(): number {
    return ((this.enableRegister >> 1) & 0x1f) + 1;
  }

  get irq(): boolean {
    const count = this.enabledCount;
    for (let i = 0; i < count; i++) if (this.oscillators[i].irqPending) return true;
    return false;
  }

  reset(): void {
    for (const osc of this.oscillators) {
      osc.control = CONTROL_HALT;
      osc.irqPending = false;
      osc.accumulator = 0;
    }
    this.enableRegister = 0;
  }

  /** Runs the oscillators up to Mega II cycle `cycle`. */
  run(cycle: number): void {
    const passCycles = (this.enabledCount + 2) * this.megaCyclesPerDocCycle;
    if (cycle - this.time > passCycles * 4096) this.time = cycle - passCycles * 4096;
    const count = this.enabledCount;
    if (this.oscillators.slice(0, count).every((osc) => osc.halted)) {
      // Nothing playing: skip the silent passes.
      const passes = Math.floor((cycle - this.time) / passCycles);
      if (passes <= 0) return;
      this.time += passes * passCycles;
      if (this.output !== 0) this.onOutput((this.output = 0), this.time);
      return;
    }
    while (this.time + passCycles <= cycle) {
      this.time += passCycles;
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const osc = this.oscillators[i];
        if (!osc.halted) sum += this.step(i, osc);
      }
      this.output = sum;
      this.onOutput(sum, this.time);
    }
  }

  /** One update of an oscillator: its next sample, scaled by its volume. */
  private step(index: number, osc: Oscillator): number {
    const size = (osc.tableSize >> 3) & 7;
    const resolution = osc.tableSize & 7;
    const shift = 9 + resolution - size;
    const sizeMask = SIZE_MASKS[size];
    const position = Math.floor(osc.accumulator / 2 ** shift);
    const address = ((osc.pointer << 8) & POINTER_MASKS[size]) | (position & sizeMask);
    osc.accumulator = (osc.accumulator + osc.frequency) % 0x1000000;
    const sample = this.ram[address & 0xffff];
    osc.data = sample;
    if (sample === 0) {
      this.halt(index, true);
      return 0;
    }
    if (position >= sizeMask) this.halt(index, false);
    return (sample - 0x80) * osc.volume;
  }

  /** The end of the table (or a zero sample): stop, loop or start the partner, and interrupt if enabled. */
  private halt(index: number, zero: boolean): void {
    const osc = this.oscillators[index];
    const partner = this.oscillators[index ^ 1];
    const mode = osc.mode;
    if (mode !== Mode.FreeRun || zero) osc.control |= CONTROL_HALT;
    else osc.accumulator = 0;
    if (mode === Mode.Swap) {
      partner.control &= ~CONTROL_HALT;
      partner.accumulator = 0;
    } else if (partner.mode === Mode.Swap && (index & 1) === 0) {
      // An even oscillator whose partner swaps starts again.
      osc.control &= ~CONTROL_HALT;
      osc.accumulator = 0;
    }
    if (osc.control & CONTROL_IRQ) osc.irqPending = true;
  }

  read(register: number): number {
    const osc = this.oscillators[register & 0x1f];
    switch (register & 0xe0) {
      case 0x00: return osc.frequency & 0xff;
      case 0x20: return osc.frequency >> 8;
      case 0x40: return osc.volume;
      case 0x60: return osc.data;
      case 0x80: return osc.pointer;
      case 0xa0: return osc.control;
      case 0xc0: return osc.tableSize;
    }
    if (register === 0xe0) return this.takeInterrupt();
    if (register === 0xe1) return this.enableRegister;
    // $E2: the A/D converter, with nothing plugged into its input.
    return 0x80;
  }

  write(register: number, value: number): void {
    const osc = this.oscillators[register & 0x1f];
    switch (register & 0xe0) {
      case 0x00: osc.frequency = (osc.frequency & 0xff00) | value; return;
      case 0x20: osc.frequency = (osc.frequency & 0xff) | (value << 8); return;
      case 0x40: osc.volume = value; return;
      case 0x60: return;
      case 0x80: osc.pointer = value; return;
      case 0xa0:
        // Starting a halted oscillator starts it from the top of its table.
        if (osc.halted && !(value & CONTROL_HALT)) osc.accumulator = 0;
        osc.control = value;
        return;
      case 0xc0: osc.tableSize = value; return;
    }
    if (register === 0xe1) this.enableRegister = value;
  }

  /** $E0: the lowest oscillator with an interrupt waiting (bit 7 clear, its number in bits 1-5), which clears it. */
  private takeInterrupt(): number {
    const count = this.enabledCount;
    for (let i = 0; i < count; i++) {
      const osc = this.oscillators[i];
      if (!osc.irqPending) continue;
      osc.irqPending = false;
      return 0x41 | (i << 1);
    }
    return 0xff;
  }
}
