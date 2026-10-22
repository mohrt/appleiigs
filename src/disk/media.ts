import { Disk35 } from './disk35';
import { FloppyDisk } from './floppy';

/** A disk for either kind of drive: an 800K 3.5" disk or a 5.25" floppy. */
export type AnyDisk = FloppyDisk | Disk35;

export const is35 = (disk: AnyDisk): disk is Disk35 => disk instanceof Disk35;

/** Reads an 800K image (.po, or a .2mg's contents) or a 5.25" one (.dsk, .do, .po, .nib, .woz). */
export function openDiskImage(name: string, data: Uint8Array): AnyDisk {
  return Disk35.isDiskSize(data.length) ? Disk35.fromImage(name, data) : FloppyDisk.fromImage(name, data);
}
