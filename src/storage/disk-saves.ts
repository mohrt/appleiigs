import { Disk35 } from '../disk/disk35';
import { FloppyDisk } from '../disk/floppy';
import { openDiskImage, type AnyDisk } from '../disk/media';
import type { KeyValueStore } from './store';

/** A disk image as games left it, in the image's own format. */
export interface DiskSaveRecord {
  name: string;
  updated: number;
  image: Uint8Array;
}

/** A blank disk created in the emulator for saving games: an 800K .po image, or a 5.25" .dsk one. */
export interface SaveDiskRecord {
  name: string;
  created: number;
  updated: number;
  bytes: Uint8Array;
}

export interface SaveDiskInfo {
  id: string;
  name: string;
  updated: number;
}

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The drives: two 3.5", two 5.25" and the hard disk. */
const DRIVES = 5;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Where the changes to a drive's disk are kept. */
export type DiskOrigin =
  | { kind: 'image'; key: string; name: string; original: Uint8Array }
  | { kind: 'saveDisk'; id: string; name: string };

/**
 * Keeps games' saves in browser storage without ever modifying the user's
 * disk images: what a game writes to a dropped image is stored, keyed by a
 * fingerprint of the original, and put back whenever that image is inserted
 * again. Blank save disks made in the emulator are stored too. Each drive has
 * its own origin.
 */
export class DiskSaves {
  private readonly origins: (DiskOrigin | null)[] = new Array(DRIVES).fill(null);

  constructor(
    private readonly overlays: KeyValueStore<DiskSaveRecord>,
    private readonly saveDisks: KeyValueStore<SaveDiskRecord>,
  ) {}

  /** A disk for a dropped image, with what games saved to it put back. */
  async openImage(drive: number, name: string, original: Uint8Array): Promise<{ disk: AnyDisk; hasSavedChanges: boolean }> {
    const key = await fingerprint(original);
    const record = await this.overlays.get(key);
    this.origins[drive] = { kind: 'image', key, name, original };
    return { disk: openDiskImage(name, record?.image ?? original), hasSavedChanges: record !== undefined };
  }

  /** A blank disk for a drive: 800K for a 3.5" drive, 140K for a 5.25" one. */
  async createSaveDisk(drive: number, large: boolean): Promise<{ disk: AnyDisk; name: string }> {
    const count = (await this.saveDisks.entries()).length;
    const name = `Save disk ${count + 1}`;
    const now = Date.now();
    const id = `save-${now}`;
    const disk = large ? Disk35.blank(`${name}.po`) : FloppyDisk.blank(`${name}.dsk`);
    await this.saveDisks.put(id, { name, created: now, updated: now, bytes: disk.toImage() });
    this.origins[drive] = { kind: 'saveDisk', id, name };
    return { disk, name };
  }

  async openSaveDisk(drive: number, id: string): Promise<{ disk: AnyDisk; name: string } | null> {
    const record = await this.saveDisks.get(id);
    if (!record) return null;
    this.origins[drive] = { kind: 'saveDisk', id, name: record.name };
    return { disk: openDiskImage(record.name, record.bytes), name: record.name };
  }

  /** Whether a save disk is an 800K one, without opening it. */
  async isLargeSaveDisk(id: string): Promise<boolean> {
    const record = await this.saveDisks.get(id);
    return record !== undefined && Disk35.isDiskSize(record.bytes.length);
  }

  async listSaveDisks(): Promise<SaveDiskInfo[]> {
    const entries = await this.saveDisks.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, updated: record.updated })).sort((a, b) => a.updated - b.updated);
  }

  async saveDiskBytes(id: string): Promise<Uint8Array | null> {
    return (await this.saveDisks.get(id))?.bytes ?? null;
  }

  async deleteSaveDisk(id: string): Promise<void> {
    await this.saveDisks.delete(id);
    this.origins.forEach((origin, drive) => {
      if (origin?.kind === 'saveDisk' && origin.id === id) this.origins[drive] = null;
    });
  }

  origin(drive: number): DiskOrigin | null {
    return this.origins[drive];
  }

  /** Stores what has been written to a drive's disk. */
  async persist(drive: number, disk: AnyDisk): Promise<void> {
    const origin = this.origins[drive];
    if (!origin) return;
    const image = disk.toImage();
    disk.dirty = false;
    if (origin.kind === 'saveDisk') {
      const record = await this.saveDisks.get(origin.id);
      if (record) await this.saveDisks.put(origin.id, { ...record, updated: Date.now(), bytes: image });
      return;
    }
    if (sameBytes(image, origin.original)) await this.overlays.delete(origin.key);
    else await this.overlays.put(origin.key, { name: origin.name, updated: Date.now(), image });
  }

  /** Forgets what games saved to a drive's image and returns a clean copy of it. */
  async revert(drive: number): Promise<AnyDisk | null> {
    const origin = this.origins[drive];
    if (origin?.kind !== 'image') return null;
    await this.overlays.delete(origin.key);
    return openDiskImage(origin.name, origin.original);
  }

  eject(drive: number): void {
    this.origins[drive] = null;
  }

  /** Makes later saves go where a restored save state's disk came from. */
  adopt(drive: number, origin: DiskOrigin | null): void {
    this.origins[drive] = origin;
  }
}
