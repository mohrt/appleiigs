import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { FloppyDisk } from '../src/disk/floppy';
import { CLOCK_HZ } from '../src/iigs';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/video/video';
import { ROM_FILES, bootMachine, haveRom, savePng, screenText } from './helpers/machine';

const file = process.env.ROM === 'rom01' ? ROM_FILES.rom01 : ROM_FILES.rom3;

it.skipIf(!process.env.DEBUG_BOOT || !haveRom(file))('boots (debugging)', () => {
  const machine = bootMachine(file);
  if (process.env.DISK) {
    machine.insertDisk(0, FloppyDisk.fromImage(process.env.DISK, new Uint8Array(readFileSync(process.env.DISK))));
    machine.powerOn();
  }
  const seconds = Number(process.env.SECONDS ?? 3);
  const pcs = new Map<number, number>();
  const cpu = machine.cpu;
  for (let i = 0; i < seconds * 60; i++) {
    machine.runCycles(Math.round(CLOCK_HZ / 60));
    const pc = (cpu.pbr << 16) | cpu.pc;
    pcs.set(pc, (pcs.get(pc) ?? 0) + 1);
  }
  console.log(screenText(machine).join('\n'));
  console.log(
    'pc',
    ((cpu.pbr << 16) | cpu.pc).toString(16),
    'e',
    cpu.e,
    'shadow',
    machine.shadow.toString(16),
    'speed',
    machine.speed.toString(16),
    'newvideo',
    machine.videoSwitches.newVideo.toString(16),
    'text',
    machine.videoSwitches.text,
    'col80',
    machine.videoSwitches.col80,
  );
  console.log('frequent PCs', [...pcs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pc, n]) => `${pc.toString(16)}:${n}`).join(' '));
  savePng(process.env.PNG ?? '/tmp/iigs.png', machine.video.framebuffer, SCREEN_WIDTH, SCREEN_HEIGHT);
});
