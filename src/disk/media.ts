import { Disk35 } from './disk35';
import { FloppyDisk } from './floppy';
import { HardDisk } from './hard-disk';

/** A disk for any drive: an 800K 3.5" disk, a 5.25" floppy or a hard disk. */
export type AnyDisk = FloppyDisk | Disk35 | HardDisk;

export const is35 = (disk: AnyDisk): disk is Disk35 => disk instanceof Disk35;
export const isHardDisk = (disk: AnyDisk): disk is HardDisk => disk instanceof HardDisk;

/** The kind of drive an image of this size goes in. */
export type DriveKind = 'disk35' | 'floppy' | 'hard';

export function driveKindOf(size: number): DriveKind {
  if (Disk35.isDiskSize(size)) return 'disk35';
  return HardDisk.isDiskSize(size) ? 'hard' : 'floppy';
}

/** Reads an 800K image (.po, or a .2mg's contents), a hard disk (.hdv, .po, .2mg) or a 5.25" one (.dsk, .do, .po, .nib, .woz). */
export function openDiskImage(name: string, data: Uint8Array): AnyDisk {
  const kind = driveKindOf(data.length);
  if (kind === 'disk35') return Disk35.fromImage(name, data);
  return kind === 'hard' ? HardDisk.fromImage(name, data) : FloppyDisk.fromImage(name, data);
}
