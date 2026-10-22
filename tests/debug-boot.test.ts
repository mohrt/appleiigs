import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { Disk35 } from '../src/disk/disk35';
import { FloppyDisk } from '../src/disk/floppy';
import { CLOCK_HZ } from '../src/iigs';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/video/video';
import { ROM_FILES, bootMachine, bootTestDisk, haveRom, savePng, screenText } from './helpers/machine';

const file = process.env.ROM === 'rom01' ? ROM_FILES.rom01 : ROM_FILES.rom3;

/**
 * Boots a ROM and prints the screen and where the CPU spent its time:
 * DISK (a 5.25" image) or DISK35 (an 800K image, or "test" for the boot test
 * disk) go in drive 1; DRIVE_LOG=1 logs the 3.5" drive's registers and commands,
 * and the disk bytes after each mark the firmware reads.
 */
it.skipIf(!process.env.DEBUG_BOOT || !haveRom(file))('boots (debugging)', () => {
  const machine = bootMachine(file);
  if (process.env.DISK) machine.insertDisk(0, FloppyDisk.fromImage(process.env.DISK, new Uint8Array(readFileSync(process.env.DISK))));
  const disk35 = process.env.DISK35;
  if (disk35) machine.insertDisk35(0, disk35 === 'test' ? bootTestDisk() : Disk35.fromImage(disk35, new Uint8Array(readFileSync(disk35))));
  const log: string[] = [];
  const afterRun: (() => void)[] = [];
  if (process.env.DRIVE_LOG) {
    const drive = machine.disk2.drives35[0];
    const sense = drive.sense.bind(drive);
    const command = drive.command.bind(drive);
    drive.sense = (select) => {
      const value = sense(select);
      if (log.length < 400) log.push(`s${select.toString(2).padStart(4, '0')}=${value ? 1 : 0}`);
      return value;
    };
    drive.command = (select, argument) => {
      log.push(`C${select.toString(2).padStart(3, '0')}:${argument ? 1 : 0}`);
      command(select, argument);
    };
    const iwm = machine.disk2;
    const access = iwm.access.bind(iwm);
    const data: string[] = [];
    const recent: number[] = [];
    iwm.access = (offset, value, cycle) => {
      const result = access(offset, value, cycle);
      if (iwm.drive35 && offset === 0x0c && !iwm.q6 && !iwm.q7 && value === null && result & 0x80) {
        recent.push(result);
        if (recent.length > 12) recent.shift();
        const [a, b] = recent;
        if (recent.length === 12 && a === 0xd5 && b === 0xaa && data.length < 60) data.push(recent.map((x) => x.toString(16)).join(','));
      }
      return result;
    };
    afterRun.push(() => console.log(`IWM mode ${iwm.mode.toString(16)}, marks read: ${data.join(' ')}`));
  }
  machine.powerOn();
  const seconds = Number(process.env.SECONDS ?? 3);
  const pcs = new Map<number, number>();
  const cpu = machine.cpu;
  for (let i = 0; i < seconds * 60; i++) {
    machine.runCycles(Math.round(CLOCK_HZ / 60));
    const pc = (cpu.pbr << 16) | cpu.pc;
    pcs.set(pc, (pcs.get(pc) ?? 0) + 1);
  }
  if (log.length) console.log(log.join(' '));
  afterRun.forEach((report) => report());
  console.log(screenText(machine).join('\n'));
  const s = machine.videoSwitches;
  console.log(`pc ${((cpu.pbr << 16) | cpu.pc).toString(16)} e ${cpu.e} shadow ${machine.shadow.toString(16)} speed ${machine.speed.toString(16)}`);
  console.log(`newvideo ${s.newVideo.toString(16)} text ${s.text} col80 ${s.col80} cylinder ${machine.disk2.drives35[0].cylinder}`);
  console.log('ram 0800', Array.from(machine.ram.subarray(0x800, 0x810), (b) => b.toString(16)).join(' '), 'ram 0300', machine.ram[0x300].toString(16), machine.ram[0x301].toString(16));
  console.log('frequent PCs', [...pcs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([pc, n]) => `${pc.toString(16)}:${n}`).join(' '));
  savePng(process.env.PNG ?? '/tmp/iigs.png', machine.video.framebuffer, SCREEN_WIDTH, SCREEN_HEIGHT);
});
