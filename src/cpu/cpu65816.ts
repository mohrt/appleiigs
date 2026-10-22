/** The 24-bit bus the 65C816 sees. */
export interface Bus816 {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

const VECTORS = {
  native: { cop: 0xffe4, brk: 0xffe6, nmi: 0xffea, irq: 0xffee },
  emulation: { cop: 0xfff4, brk: 0xfffe, nmi: 0xfffa, irq: 0xfffe, reset: 0xfffc },
};

/** The arithmetic and load/store group: the operation is in the top three bits of the opcode. */
const enum AluOp {
  Ora,
  And,
  Eor,
  Adc,
  Sta,
  Lda,
  Cmp,
  Sbc,
}

/**
 * The WDC 65C816, stepped one instruction at a time and counting every bus
 * cycle (reads, writes and internal operations) as the datasheet lists them,
 * so 16-bit operands, a direct page off a page boundary, index page crossings
 * and the emulation mode's wrap-arounds all cost what they do on the chip.
 */
export class Cpu65816 {
  /** The 16-bit accumulator C (B:A); with M set only its low byte is A. */
  a = 0;
  x = 0;
  y = 0;
  s = 0x01ff;
  d = 0;
  dbr = 0;
  pbr = 0;
  pc = 0;

  flagN = false;
  flagV = false;
  /** 8-bit accumulator and memory. */
  flagM = true;
  /** 8-bit index registers. */
  flagX = true;
  flagD = false;
  flagI = true;
  flagZ = false;
  flagC = false;
  /** Emulation mode: the 6502's registers and stack page. */
  e = true;

  cycles = 0;
  /** The bank vectors are fetched from (the IIgs always takes them from its ROM, in bank $FF). */
  vectorBank = 0;
  /** Level-triggered IRQ input. */
  irqLine = false;
  /** WAI: waiting for an interrupt. */
  waiting = false;
  /** STP: stopped until reset. */
  stopped = false;
  private nmiPending = false;
  /** Set by addressing modes whose operands wrap within bank 0 (direct page and the stack). */
  private bank0 = false;

  constructor(private readonly bus: Bus816) {}

  reset(): void {
    this.e = true;
    this.flagM = this.flagX = true;
    this.flagD = false;
    this.flagI = true;
    this.x &= 0xff;
    this.y &= 0xff;
    this.d = 0;
    this.dbr = this.pbr = 0;
    this.s = 0x0100 | (this.s & 0xff);
    this.waiting = this.stopped = false;
    this.nmiPending = false;
    const vector = (this.vectorBank << 16) | VECTORS.emulation.reset;
    this.pc = this.bus.read(vector) | (this.bus.read(vector + 1) << 8);
  }

  triggerNmi(): void {
    this.nmiPending = true;
  }

  get p(): number {
    return (
      (this.flagN ? 0x80 : 0) |
      (this.flagV ? 0x40 : 0) |
      (this.e || this.flagM ? 0x20 : 0) |
      (this.e || this.flagX ? 0x10 : 0) |
      (this.flagD ? 0x08 : 0) |
      (this.flagI ? 0x04 : 0) |
      (this.flagZ ? 0x02 : 0) |
      (this.flagC ? 0x01 : 0)
    );
  }

  set p(value: number) {
    this.flagN = (value & 0x80) !== 0;
    this.flagV = (value & 0x40) !== 0;
    this.flagM = this.e || (value & 0x20) !== 0;
    this.flagX = this.e || (value & 0x10) !== 0;
    this.flagD = (value & 0x08) !== 0;
    this.flagI = (value & 0x04) !== 0;
    this.flagZ = (value & 0x02) !== 0;
    this.flagC = (value & 0x01) !== 0;
    if (this.flagX) {
      this.x &= 0xff;
      this.y &= 0xff;
    }
  }

  /** Executes one instruction (or interrupt entry) and returns the cycles used. */
  step(): number {
    const start = this.cycles;
    if (this.stopped) {
      this.cycles++;
      return 1;
    }
    if (this.nmiPending || (this.irqLine && !this.flagI)) {
      if (this.waiting) this.waiting = false;
      if (this.nmiPending) {
        this.nmiPending = false;
        this.idle();
        this.idle();
        this.interrupt('nmi', false);
      } else {
        this.idle();
        this.idle();
        this.interrupt('irq', false);
      }
      return this.cycles - start;
    }
    if (this.waiting) {
      // WAI with interrupts masked still wakes on IRQ, without taking it.
      if (this.irqLine) this.waiting = false;
      else {
        this.cycles++;
        return 1;
      }
    }
    this.execute(this.fetch());
    return this.cycles - start;
  }

  // --- Bus cycles -----------------------------------------------------------------

  private rd(addr: number): number {
    this.cycles++;
    return this.bus.read(addr & 0xffffff);
  }

  private wr(addr: number, value: number): void {
    this.cycles++;
    this.bus.write(addr & 0xffffff, value & 0xff);
  }

  private idle(): void {
    this.cycles++;
  }

  private fetch(): number {
    const value = this.rd((this.pbr << 16) | this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return value;
  }

  private fetch16(): number {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }

  private fetch24(): number {
    const word = this.fetch16();
    return word | (this.fetch() << 16);
  }

  /** The address after `addr`: within bank 0 for direct page and stack operands, else across banks. */
  private next(addr: number): number {
    return this.bank0 ? (addr + 1) & 0xffff : (addr + 1) & 0xffffff;
  }

  private read16(addr: number): number {
    return this.rd(addr) | (this.rd(this.next(addr)) << 8);
  }

  /** An operand of the accumulator's width. */
  private readM(addr: number): number {
    return this.flagM ? this.rd(addr) : this.read16(addr);
  }

  private readX(addr: number): number {
    return this.flagX ? this.rd(addr) : this.read16(addr);
  }

  private writeWide(addr: number, value: number, narrow: boolean): void {
    this.wr(addr, value);
    if (!narrow) this.wr(this.next(addr), value >> 8);
  }

  private immediate(narrow: boolean): number {
    return narrow ? this.fetch() : this.fetch16();
  }

  // --- The stack (bank 0) -----------------------------------------------------------

  /** A push as the 6502's instructions do it: in emulation mode the stack stays on page 1. */
  private push(value: number): void {
    this.wr(this.s, value);
    this.s = this.e ? 0x0100 | ((this.s - 1) & 0xff) : (this.s - 1) & 0xffff;
  }

  private pull(): number {
    this.s = this.e ? 0x0100 | ((this.s + 1) & 0xff) : (this.s + 1) & 0xffff;
    return this.rd(this.s);
  }

  /** The 65816's own stack instructions run past page 1 in emulation mode; S is put back on it after. */
  private pushNew(value: number): void {
    this.wr(this.s, value);
    this.s = (this.s - 1) & 0xffff;
  }

  private pullNew(): number {
    this.s = (this.s + 1) & 0xffff;
    return this.rd(this.s);
  }

  private fixStack(): void {
    if (this.e) this.s = 0x0100 | (this.s & 0xff);
  }

  private pushWide(value: number, narrow: boolean): void {
    if (!narrow) this.push(value >> 8);
    this.push(value);
  }

  private pullWide(narrow: boolean): number {
    const lo = this.pull();
    return narrow ? lo : lo | (this.pull() << 8);
  }

  // --- Addressing modes: each returns a 24-bit effective address -----------------------

  /** Direct page addresses take a cycle more when D isn't on a page boundary. */
  private dpPenalty(): void {
    if (this.d & 0xff) this.idle();
  }

  /** In emulation mode with D on a page boundary, indexed direct page addresses wrap within the page. */
  private dpWraps(): boolean {
    return this.e && (this.d & 0xff) === 0;
  }

  private dp(): number {
    const offset = this.fetch();
    this.dpPenalty();
    this.bank0 = true;
    return (this.d + offset) & 0xffff;
  }

  private dpIndexed(index: number): number {
    const offset = this.fetch();
    this.dpPenalty();
    this.idle();
    this.bank0 = true;
    return this.dpWraps() ? (this.d & 0xff00) | ((offset + index) & 0xff) : (this.d + offset + index) & 0xffff;
  }

  /** A pointer in the direct page; in emulation mode on a page boundary its high byte wraps within the page. */
  private dpPointer(addr: number): number {
    const lo = this.rd(addr);
    const hiAddr = this.dpWraps() ? (addr & 0xff00) | ((addr + 1) & 0xff) : (addr + 1) & 0xffff;
    return lo | (this.rd(hiAddr) << 8);
  }

  /** An indexed address: reads take a cycle more on a page crossing or with 16-bit index registers, writes always. */
  private indexed(base: number, index: number, write: boolean): number {
    const addr = (base + index) & 0xffffff;
    if (write || !this.flagX || (base & 0xffff00) !== (addr & 0xffff00)) this.idle();
    this.bank0 = false;
    return addr;
  }

  private absolute(): number {
    this.bank0 = false;
    return (this.dbr << 16) | this.fetch16();
  }

  /** The effective address of the arithmetic and load/store group's operand, by the opcode's low five bits. */
  private aluAddress(mode: number, write: boolean): number {
    switch (mode) {
      case 0x01: { // (dp,X)
        const addr = this.dpIndexed(this.x);
        this.bank0 = false;
        return (this.dbr << 16) | this.dpPointer(addr);
      }
      case 0x03: { // sr,S
        const offset = this.fetch();
        this.idle();
        this.bank0 = true;
        return (this.s + offset) & 0xffff;
      }
      case 0x05:
        return this.dp();
      case 0x07: { // [dp]
        const addr = this.dp();
        const ptr = this.rd(addr) | (this.rd((addr + 1) & 0xffff) << 8) | (this.rd((addr + 2) & 0xffff) << 16);
        this.bank0 = false;
        return ptr;
      }
      case 0x0d:
        return this.absolute();
      case 0x0f:
        this.bank0 = false;
        return this.fetch24();
      case 0x11: { // (dp),Y
        const ptr = this.dpPointer(this.dp());
        return this.indexed((this.dbr << 16) | ptr, this.y, write);
      }
      case 0x12: { // (dp)
        const ptr = this.dpPointer(this.dp());
        this.bank0 = false;
        return (this.dbr << 16) | ptr;
      }
      case 0x13: { // (sr,S),Y
        const offset = this.fetch();
        this.idle();
        const addr = (this.s + offset) & 0xffff;
        const ptr = this.rd(addr) | (this.rd((addr + 1) & 0xffff) << 8);
        this.idle();
        this.bank0 = false;
        return (((this.dbr << 16) | ptr) + this.y) & 0xffffff;
      }
      case 0x15:
        return this.dpIndexed(this.x);
      case 0x17: { // [dp],Y
        const addr = this.dp();
        const ptr = this.rd(addr) | (this.rd((addr + 1) & 0xffff) << 8) | (this.rd((addr + 2) & 0xffff) << 16);
        this.bank0 = false;
        return (ptr + this.y) & 0xffffff;
      }
      case 0x19:
        return this.indexed(this.absolute(), this.y, write);
      case 0x1d:
        return this.indexed(this.absolute(), this.x, write);
      default: // 0x1f: long,X
        this.bank0 = false;
        return (this.fetch24() + this.x) & 0xffffff;
    }
  }

  // --- Operations -----------------------------------------------------------------

  private setNZ(value: number, narrow: boolean): number {
    const masked = narrow ? value & 0xff : value & 0xffff;
    this.flagZ = masked === 0;
    this.flagN = (masked & (narrow ? 0x80 : 0x8000)) !== 0;
    return masked;
  }

  /** Sets A (only its low byte with M set) and the flags. */
  private setA(value: number): void {
    if (this.flagM) this.a = (this.a & 0xff00) | this.setNZ(value, true);
    else this.a = this.setNZ(value, false);
  }

  private get accumulator(): number {
    return this.flagM ? this.a & 0xff : this.a;
  }

  private setIndex(register: 'x' | 'y', value: number): void {
    this[register] = this.setNZ(value, this.flagX);
  }

  /**
   * ADC, and SBC (which adds the operand's complement). In decimal mode the
   * digits are added one at a time and adjusted as the chip does, which also
   * gives its results for digits above 9; overflow comes from the top digit
   * before its adjustment.
   */
  private add(value: number, subtract: boolean): void {
    const narrow = this.flagM;
    const a = this.accumulator;
    const data = subtract ? value ^ (narrow ? 0xff : 0xffff) : value;
    const sign = narrow ? 0x80 : 0x8000;
    let carry = this.flagC ? 1 : 0;
    let result: number;
    if (!this.flagD) {
      result = a + data + carry;
      this.flagV = (~(a ^ data) & (a ^ result) & sign) !== 0;
      carry = result > (narrow ? 0xff : 0xffff) ? 1 : 0;
    } else {
      result = 0;
      const digits = narrow ? 2 : 4;
      for (let digit = 0; digit < digits; digit++) {
        const shift = digit * 4;
        const mask = 0xf << shift;
        result = (a & mask) + (data & mask) + (carry << shift) + (result & ((1 << shift) - 1));
        if (digit === digits - 1) this.flagV = (~(a ^ data) & (a ^ result) & sign) !== 0;
        if (!subtract && result > (0xa << shift) - 1) result += 6 << shift;
        if (subtract && result <= (0x10 << shift) - 1) result -= 6 << shift;
        carry = result > (0x10 << shift) - 1 ? 1 : 0;
      }
    }
    this.flagC = carry === 1;
    this.setA(result);
  }

  private compare(register: number, value: number, narrow: boolean): void {
    const result = register - value;
    this.flagC = result >= 0;
    this.setNZ(result, narrow);
  }

  private bit(value: number, immediate: boolean): void {
    const narrow = this.flagM;
    this.flagZ = (this.accumulator & value) === 0;
    if (immediate) return;
    this.flagN = (value & (narrow ? 0x80 : 0x8000)) !== 0;
    this.flagV = (value & (narrow ? 0x40 : 0x4000)) !== 0;
  }

  private alu(op: AluOp, value: number): void {
    switch (op) {
      case AluOp.Ora: this.setA(this.accumulator | value); break;
      case AluOp.And: this.setA(this.accumulator & value); break;
      case AluOp.Eor: this.setA(this.accumulator ^ value); break;
      case AluOp.Adc: this.add(value, false); break;
      case AluOp.Lda: this.setA(value); break;
      case AluOp.Cmp: this.compare(this.accumulator, value, this.flagM); break;
      case AluOp.Sbc: this.add(value, true); break;
    }
  }

  /** Shifts, rotates, increments, decrements, TSB and TRB, at the accumulator's width. */
  private modify(kind: number, value: number): number {
    const narrow = this.flagM;
    const top = narrow ? 0x80 : 0x8000;
    const mask = narrow ? 0xff : 0xffff;
    switch (kind) {
      case 0: // ASL
        this.flagC = (value & top) !== 0;
        return this.setNZ(value << 1, narrow);
      case 1: { // ROL
        const result = (value << 1) | (this.flagC ? 1 : 0);
        this.flagC = (value & top) !== 0;
        return this.setNZ(result, narrow);
      }
      case 2: // LSR
        this.flagC = (value & 1) !== 0;
        return this.setNZ(value >> 1, narrow);
      case 3: { // ROR
        const result = (value >> 1) | (this.flagC ? top : 0);
        this.flagC = (value & 1) !== 0;
        return this.setNZ(result, narrow);
      }
      case 6: // DEC
        return this.setNZ(value - 1, narrow);
      case 7: // INC
        return this.setNZ(value + 1, narrow);
      case 8: // TSB
        this.flagZ = (this.accumulator & value) === 0;
        return (value | this.accumulator) & mask;
      default: // 9: TRB
        this.flagZ = (this.accumulator & value) === 0;
        return value & ~this.accumulator & mask;
    }
  }

  /** Read-modify-write on memory: 16-bit results are written high byte first. */
  private rmw(addr: number, kind: number): void {
    const value = this.readM(addr);
    this.idle();
    const result = this.modify(kind, value);
    if (!this.flagM) this.wr(this.next(addr), result >> 8);
    this.wr(addr, result);
  }

  private branch(condition: boolean): void {
    const offset = this.fetch();
    if (!condition) return;
    this.idle();
    const target = (this.pc + (offset < 0x80 ? offset : offset - 0x100)) & 0xffff;
    if (this.e && (target & 0xff00) !== (this.pc & 0xff00)) this.idle();
    this.pc = target;
  }

  private interrupt(kind: 'nmi' | 'irq' | 'brk' | 'cop', software: boolean): void {
    if (!this.e) this.push(this.pbr);
    this.push(this.pc >> 8);
    this.push(this.pc);
    this.push(this.e && !software ? this.p & ~0x10 : this.p);
    this.flagI = true;
    this.flagD = false;
    this.pbr = 0;
    const vector = (this.vectorBank << 16) | (this.e ? VECTORS.emulation[kind] : VECTORS.native[kind]);
    this.pc = this.rd(vector) | (this.rd(vector + 1) << 8);
  }

  /** Whether the processor-status change left 8-bit index registers. */
  private setP(value: number): void {
    this.p = value;
  }

  private transfer(to: 'a' | 'x' | 'y', value: number, narrow: boolean): void {
    this.idle();
    if (to === 'a') {
      if (narrow) this.a = (this.a & 0xff00) | this.setNZ(value, true);
      else this.a = this.setNZ(value, false);
    } else {
      this[to] = this.setNZ(value, narrow);
    }
  }

  private execute(opcode: number): void {
    // The arithmetic and load/store group.
    const low = opcode & 0x1f;
    const column = opcode & 0x0f;
    if ((opcode & 0x03) === 0x01 || column === 0x03 || column === 0x07 || column === 0x0f || low === 0x12) {
      const op = (opcode >> 5) as AluOp;
      if (low === 0x09) {
        if (op === AluOp.Sta) this.bit(this.immediate(this.flagM), true); // $89: BIT #
        else this.alu(op, this.immediate(this.flagM));
        return;
      }
      const addr = this.aluAddress(low, op === AluOp.Sta);
      if (op === AluOp.Sta) this.writeWide(addr, this.accumulator, this.flagM);
      else this.alu(op, this.readM(addr));
      return;
    }

    switch (opcode) {
      // Read-modify-write on memory: ASL, ROL, LSR, ROR, DEC, INC
      case 0x06: case 0x26: case 0x46: case 0x66: case 0xc6: case 0xe6:
        this.rmw(this.dp(), this.rmwKind(opcode));
        break;
      case 0x0e: case 0x2e: case 0x4e: case 0x6e: case 0xce: case 0xee:
        this.rmw(this.absolute(), this.rmwKind(opcode));
        break;
      case 0x16: case 0x36: case 0x56: case 0x76: case 0xd6: case 0xf6:
        this.rmw(this.dpIndexed(this.x), this.rmwKind(opcode));
        break;
      case 0x1e: case 0x3e: case 0x5e: case 0x7e: case 0xde: case 0xfe:
        this.rmw(this.indexed(this.absolute(), this.x, true), this.rmwKind(opcode));
        break;
      case 0x0a: case 0x2a: case 0x4a: case 0x6a:
        this.idle();
        this.writeAccumulator(this.modify(opcode >> 5, this.accumulator));
        break;
      case 0x1a:
        this.idle();
        this.writeAccumulator(this.modify(7, this.accumulator));
        break;
      case 0x3a:
        this.idle();
        this.writeAccumulator(this.modify(6, this.accumulator));
        break;
      case 0x04: this.rmw(this.dp(), 8); break; // TSB
      case 0x0c: this.rmw(this.absolute(), 8); break;
      case 0x14: this.rmw(this.dp(), 9); break; // TRB
      case 0x1c: this.rmw(this.absolute(), 9); break;

      // BIT
      case 0x24: this.bit(this.readM(this.dp()), false); break;
      case 0x2c: this.bit(this.readM(this.absolute()), false); break;
      case 0x34: this.bit(this.readM(this.dpIndexed(this.x)), false); break;
      case 0x3c: this.bit(this.readM(this.indexed(this.absolute(), this.x, false)), false); break;

      // Loads and stores of X, Y and zero
      case 0xa2: this.setIndex('x', this.immediate(this.flagX)); break;
      case 0xa6: this.setIndex('x', this.readX(this.dp())); break;
      case 0xb6: this.setIndex('x', this.readX(this.dpIndexed(this.y))); break;
      case 0xae: this.setIndex('x', this.readX(this.absolute())); break;
      case 0xbe: this.setIndex('x', this.readX(this.indexed(this.absolute(), this.y, false))); break;
      case 0xa0: this.setIndex('y', this.immediate(this.flagX)); break;
      case 0xa4: this.setIndex('y', this.readX(this.dp())); break;
      case 0xb4: this.setIndex('y', this.readX(this.dpIndexed(this.x))); break;
      case 0xac: this.setIndex('y', this.readX(this.absolute())); break;
      case 0xbc: this.setIndex('y', this.readX(this.indexed(this.absolute(), this.x, false))); break;
      case 0x86: this.writeWide(this.dp(), this.x, this.flagX); break;
      case 0x96: this.writeWide(this.dpIndexed(this.y), this.x, this.flagX); break;
      case 0x8e: this.writeWide(this.absolute(), this.x, this.flagX); break;
      case 0x84: this.writeWide(this.dp(), this.y, this.flagX); break;
      case 0x94: this.writeWide(this.dpIndexed(this.x), this.y, this.flagX); break;
      case 0x8c: this.writeWide(this.absolute(), this.y, this.flagX); break;
      case 0x64: this.writeWide(this.dp(), 0, this.flagM); break;
      case 0x74: this.writeWide(this.dpIndexed(this.x), 0, this.flagM); break;
      case 0x9c: this.writeWide(this.absolute(), 0, this.flagM); break;
      case 0x9e: this.writeWide(this.indexed(this.absolute(), this.x, true), 0, this.flagM); break;

      // Compares of X and Y
      case 0xe0: this.compare(this.x, this.immediate(this.flagX), this.flagX); break;
      case 0xe4: this.compare(this.x, this.readX(this.dp()), this.flagX); break;
      case 0xec: this.compare(this.x, this.readX(this.absolute()), this.flagX); break;
      case 0xc0: this.compare(this.y, this.immediate(this.flagX), this.flagX); break;
      case 0xc4: this.compare(this.y, this.readX(this.dp()), this.flagX); break;
      case 0xcc: this.compare(this.y, this.readX(this.absolute()), this.flagX); break;

      // Register increments and decrements
      case 0xe8: this.idle(); this.setIndex('x', this.x + 1); break;
      case 0xca: this.idle(); this.setIndex('x', this.x - 1); break;
      case 0xc8: this.idle(); this.setIndex('y', this.y + 1); break;
      case 0x88: this.idle(); this.setIndex('y', this.y - 1); break;

      // Transfers
      case 0xaa: this.transfer('x', this.a, this.flagX); break; // TAX
      case 0xa8: this.transfer('y', this.a, this.flagX); break; // TAY
      case 0x8a: this.transfer('a', this.x, this.flagM); break; // TXA
      case 0x98: this.transfer('a', this.y, this.flagM); break; // TYA
      case 0x9b: this.transfer('y', this.x, this.flagX); break; // TXY
      case 0xbb: this.transfer('x', this.y, this.flagX); break; // TYX
      case 0xba: this.transfer('x', this.s, this.flagX); break; // TSX
      case 0x9a: // TXS
        this.idle();
        this.s = this.e ? 0x0100 | (this.x & 0xff) : this.x;
        break;
      case 0x5b: this.idle(); this.d = this.setNZ(this.a, false); break; // TCD
      case 0x7b: this.idle(); this.a = this.setNZ(this.d, false); break; // TDC
      case 0x1b: // TCS
        this.idle();
        this.s = this.e ? 0x0100 | (this.a & 0xff) : this.a;
        break;
      case 0x3b: this.idle(); this.a = this.setNZ(this.s, false); break; // TSC
      case 0xeb: // XBA
        this.idle();
        this.idle();
        this.a = ((this.a >> 8) | (this.a << 8)) & 0xffff;
        this.setNZ(this.a, true);
        break;

      // The stack
      case 0x48: this.idle(); this.pushWide(this.a, this.flagM); break; // PHA
      case 0x68: this.idle(); this.idle(); this.setA(this.pullWide(this.flagM)); break; // PLA
      case 0xda: this.idle(); this.pushWide(this.x, this.flagX); break; // PHX
      case 0xfa: this.idle(); this.idle(); this.setIndex('x', this.pullWide(this.flagX)); break; // PLX
      case 0x5a: this.idle(); this.pushWide(this.y, this.flagX); break; // PHY
      case 0x7a: this.idle(); this.idle(); this.setIndex('y', this.pullWide(this.flagX)); break; // PLY
      case 0x08: this.idle(); this.push(this.p); break; // PHP
      case 0x28: this.idle(); this.idle(); this.setP(this.pull()); break; // PLP
      case 0x8b: this.idle(); this.pushNew(this.dbr); this.fixStack(); break; // PHB
      case 0xab: // PLB
        this.idle();
        this.idle();
        this.dbr = this.setNZ(this.pullNew(), true);
        this.fixStack();
        break;
      case 0x4b: this.idle(); this.pushNew(this.pbr); this.fixStack(); break; // PHK
      case 0x0b: // PHD
        this.idle();
        this.pushNew(this.d >> 8);
        this.pushNew(this.d);
        this.fixStack();
        break;
      case 0x2b: { // PLD
        this.idle();
        this.idle();
        const lo = this.pullNew();
        this.d = this.setNZ(lo | (this.pullNew() << 8), false);
        this.fixStack();
        break;
      }
      case 0xf4: { // PEA
        const value = this.fetch16();
        this.pushNew(value >> 8);
        this.pushNew(value);
        this.fixStack();
        break;
      }
      case 0xd4: { // PEI
        const addr = this.dp();
        const value = this.rd(addr) | (this.rd((addr + 1) & 0xffff) << 8);
        this.pushNew(value >> 8);
        this.pushNew(value);
        this.fixStack();
        break;
      }
      case 0x62: { // PER
        const offset = this.fetch16();
        this.idle();
        const value = (this.pc + offset) & 0xffff;
        this.pushNew(value >> 8);
        this.pushNew(value);
        this.fixStack();
        break;
      }

      // Flags
      case 0x18: this.idle(); this.flagC = false; break;
      case 0x38: this.idle(); this.flagC = true; break;
      case 0x58: this.idle(); this.flagI = false; break;
      case 0x78: this.idle(); this.flagI = true; break;
      case 0xb8: this.idle(); this.flagV = false; break;
      case 0xd8: this.idle(); this.flagD = false; break;
      case 0xf8: this.idle(); this.flagD = true; break;
      case 0xc2: { // REP
        const bits = this.fetch();
        this.idle();
        this.setP(this.p & ~bits);
        break;
      }
      case 0xe2: { // SEP
        const bits = this.fetch();
        this.idle();
        this.setP(this.p | bits);
        break;
      }
      case 0xfb: { // XCE
        this.idle();
        const carry = this.flagC;
        this.flagC = this.e;
        this.e = carry;
        if (this.e) {
          this.flagM = this.flagX = true;
          this.x &= 0xff;
          this.y &= 0xff;
          this.s = 0x0100 | (this.s & 0xff);
        }
        break;
      }

      // Branches
      case 0x10: this.branch(!this.flagN); break;
      case 0x30: this.branch(this.flagN); break;
      case 0x50: this.branch(!this.flagV); break;
      case 0x70: this.branch(this.flagV); break;
      case 0x90: this.branch(!this.flagC); break;
      case 0xb0: this.branch(this.flagC); break;
      case 0xd0: this.branch(!this.flagZ); break;
      case 0xf0: this.branch(this.flagZ); break;
      case 0x80: this.branch(true); break;
      case 0x82: { // BRL
        const offset = this.fetch16();
        this.idle();
        this.pc = (this.pc + offset) & 0xffff;
        break;
      }

      // Jumps and calls
      case 0x4c: this.pc = this.fetch16(); break;
      case 0x5c: { // JML long
        const target = this.fetch24();
        this.pc = target & 0xffff;
        this.pbr = target >> 16;
        break;
      }
      case 0x6c: { // JMP (abs), pointer in bank 0
        const ptr = this.fetch16();
        this.pc = this.rd(ptr) | (this.rd((ptr + 1) & 0xffff) << 8);
        break;
      }
      case 0x7c: { // JMP (abs,X), pointer in the program bank
        const ptr = this.fetch16();
        this.idle();
        const bank = this.pbr << 16;
        this.pc = this.rd(bank | ((ptr + this.x) & 0xffff)) | (this.rd(bank | ((ptr + this.x + 1) & 0xffff)) << 8);
        break;
      }
      case 0xdc: { // JML [abs]
        const ptr = this.fetch16();
        const lo = this.rd(ptr);
        const hi = this.rd((ptr + 1) & 0xffff);
        this.pbr = this.rd((ptr + 2) & 0xffff);
        this.pc = lo | (hi << 8);
        break;
      }
      case 0x20: { // JSR abs
        const target = this.fetch16();
        this.idle();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret);
        this.pc = target;
        break;
      }
      case 0xfc: { // JSR (abs,X): the return address goes on before the pointer's high byte is read
        const lo = this.fetch();
        this.pushNew(this.pc >> 8);
        this.pushNew(this.pc);
        const ptr = lo | (this.fetch() << 8);
        this.idle();
        const bank = this.pbr << 16;
        this.pc = this.rd(bank | ((ptr + this.x) & 0xffff)) | (this.rd(bank | ((ptr + this.x + 1) & 0xffff)) << 8);
        this.fixStack();
        break;
      }
      case 0x22: { // JSL
        const target = this.fetch16();
        this.pushNew(this.pbr);
        this.idle();
        const bank = this.fetch();
        const ret = (this.pc - 1) & 0xffff;
        this.pushNew(ret >> 8);
        this.pushNew(ret);
        this.pc = target;
        this.pbr = bank;
        this.fixStack();
        break;
      }
      case 0x60: { // RTS
        this.idle();
        this.idle();
        const lo = this.pull();
        this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff;
        this.idle();
        break;
      }
      case 0x6b: { // RTL
        this.idle();
        this.idle();
        const lo = this.pullNew();
        const hi = this.pullNew();
        this.pbr = this.pullNew();
        this.pc = ((lo | (hi << 8)) + 1) & 0xffff;
        this.fixStack();
        break;
      }
      case 0x40: { // RTI
        this.idle();
        this.idle();
        this.setP(this.pull());
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        if (!this.e) this.pbr = this.pull();
        break;
      }
      case 0x00: // BRK
        this.fetch();
        this.interrupt('brk', true);
        break;
      case 0x02: // COP
        this.fetch();
        this.interrupt('cop', true);
        break;

      // Block moves: one byte each time round; the PC goes back until A counts past zero.
      case 0x54: case 0x44: {
        const destination = this.fetch();
        const source = this.fetch();
        this.dbr = destination;
        const value = this.rd((source << 16) | this.x);
        this.wr((destination << 16) | this.y, value);
        this.idle();
        this.idle();
        const step = opcode === 0x54 ? 1 : -1;
        const mask = this.flagX ? 0xff : 0xffff;
        this.x = (this.x + step) & mask;
        this.y = (this.y + step) & mask;
        this.a = (this.a - 1) & 0xffff;
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff;
        break;
      }

      case 0xcb: this.idle(); this.idle(); this.idle(); this.waiting = true; break; // WAI
      case 0xdb: this.idle(); this.idle(); this.idle(); this.stopped = true; break; // STP
      case 0x42: this.fetch(); break; // WDM
      case 0xea: this.idle(); break; // NOP
    }
  }

  private rmwKind(opcode: number): number {
    const group = opcode >> 5;
    return group === 6 ? 6 : group === 7 ? 7 : group;
  }

  private writeAccumulator(value: number): void {
    if (this.flagM) this.a = (this.a & 0xff00) | (value & 0xff);
    else this.a = value & 0xffff;
  }
}
