import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cpu65816 } from '../src/cpu/cpu65816';

const dir = join(import.meta.dirname, 'fixtures', '65816');

interface CpuState {
  pc: number;
  s: number;
  p: number;
  a: number;
  x: number;
  y: number;
  dbr: number;
  d: number;
  pbr: number;
  e: number;
  ram: [number, number][];
}

interface SingleStepTest {
  name: string;
  initial: CpuState;
  final: CpuState;
  cycles: unknown[];
}

/** Runs every test in a file; returns the first failure of each opcode and mode. */
function run(file: string): string | null {
  const tests = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SingleStepTest[];
  for (const test of tests) {
    const memory = new Map<number, number>();
    const cpu = new Cpu65816({ read: (addr) => memory.get(addr) ?? 0, write: (addr, value) => memory.set(addr, value) });
    const { initial, final } = test;
    for (const [addr, value] of initial.ram) memory.set(addr, value);
    Object.assign(cpu, { pc: initial.pc, s: initial.s, a: initial.a, x: initial.x, y: initial.y, dbr: initial.dbr, d: initial.d, pbr: initial.pbr });
    // In emulation mode the chip keeps S on page 1; with 8-bit index registers their high bytes are 0.
    cpu.e = initial.e === 1;
    cpu.p = initial.p;
    if (cpu.e) cpu.s = 0x0100 | (cpu.s & 0xff);
    // A block move goes round once per byte; the tests take it to the end.
    const opcode = memory.get((initial.pbr << 16) | initial.pc);
    let cycles = cpu.step();
    while ((opcode === 0x44 || opcode === 0x54) && cpu.pc === initial.pc && cycles < 1_000_000) cycles += cpu.step();
    const got = { pc: cpu.pc, s: cpu.s, p: cpu.p, a: cpu.a, x: cpu.x, y: cpu.y, dbr: cpu.dbr, d: cpu.d, pbr: cpu.pbr, e: cpu.e ? 1 : 0 };
    const want = { pc: final.pc, s: final.s, p: final.p, a: final.a, x: final.x, y: final.y, dbr: final.dbr, d: final.d, pbr: final.pbr, e: final.e };
    const ramWrong = final.ram.filter(([addr, value]) => (memory.get(addr) ?? 0) !== value);
    if (JSON.stringify(got) !== JSON.stringify(want) || ramWrong.length || cycles !== test.cycles.length) {
      return `${test.name}: got ${JSON.stringify(got)} in ${cycles}, want ${JSON.stringify(want)} in ${test.cycles.length}${ramWrong.length ? ` memory ${JSON.stringify(ramWrong.slice(0, 3))}` : ''}`;
    }
  }
  return null;
}

describe.skipIf(!existsSync(dir))("Tom Harte's 65816 single-step tests", () => {
  it('match the 65C816 on every opcode, in emulation and native mode', () => {
    const failures = readdirSync(dir).sort().map(run).filter((failure): failure is string => failure !== null);
    expect(failures).toEqual([]);
  });
});
