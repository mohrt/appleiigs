import { Disk35 } from './disk35';
import { isZip, usableFilesInZip } from './zip';

export const STATE_EXTENSION = '.gsstate';
export const DISK_EXTENSIONS = ['.dsk', '.do', '.po', '.nib', '.woz', '.2mg'];

export type Media = { kind: 'disk'; name: string; data: Uint8Array } | { kind: 'state'; bytes: Uint8Array };

const isGzip = (data: Uint8Array) => data[0] === 0x1f && data[1] === 0x8b;
const TWO_IMG = [0x32, 0x49, 0x4d, 0x47]; // "2IMG"
const TWO_IMG_EXTENSIONS = ['.do', '.po', '.nib'];

/** The disk inside a .2mg file, named with the extension of its sector order. */
function unwrap2mg(name: string, data: Uint8Array): { name: string; data: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = view.getUint32(12, true);
  const offset = view.getUint32(24, true);
  const length = view.getUint32(28, true) || data.length - offset;
  if (format > 2 || offset + length > data.length) throw new Error(`${name} is a .2mg file this emulator can't read.`);
  return { name: name.replace(/\.2mg$/i, TWO_IMG_EXTENSIONS[format]), data: data.slice(offset, offset + length) };
}

/** The files a dropped file stands for: itself, or the usable files in a zip (best first). */
export async function filesFrom(file: File): Promise<File[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZip(head)) return [file];
  const files = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
  if (files.length === 0) throw new Error(`${file.name} has no Apple II or IIgs disk images (.po, .2mg, .dsk, .do, .nib or .woz) in it.`);
  return files;
}

/** Works out what a file is: a disk image or a save state. */
export async function readMedia(file: File): Promise<Media> {
  const data = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(STATE_EXTENSION) || isGzip(data)) return { kind: 'state', bytes: data };
  if (TWO_IMG.every((byte, i) => data[i] === byte)) return { kind: 'disk', ...unwrap2mg(file.name, data) };
  if (name.endsWith('.hdv') || (data.length > 300_000 && !Disk35.isDiskSize(data.length))) {
    throw new Error(`${file.name} is a hard disk image, which this IIgs can't use yet: it takes 800K 3.5" disks (.po, .2mg) and 5.25" disks.`);
  }
  return { kind: 'disk', name: file.name, data };
}

/** "Ultima IV (Disk 1 of 4).woz" → "Ultima IV (Disk 1 of 4)". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.(dsk|do|po|nib|woz|2mg|zip)$/i, '').trim() || name;
}

/** The disk to put in first from several: the boot or program disk of a set, otherwise the first by name ("Disk 1"). */
export function firstDisk(files: File[]): File {
  return files.find((file) => /\b(boot|program)\b/i.test(file.name)) ?? files[0];
}
