import { BLOCK_BYTES, DISK35_BYTES } from './disk35';

/** ProDOS volumes stop at 65,535 blocks (32 MB). */
export const MAX_HARD_DISK_BLOCKS = 0xffff;

/**
 * A hard disk image: ProDOS-ordered 512-byte blocks (.hdv, .po, or a .2mg's
 * contents), larger than an 800K floppy. Written blocks change the image
 * directly; it is saved as it is.
 */
export class HardDisk {
  dirty = false;
  writeProtected = false;

  constructor(
    readonly name: string,
    readonly data: Uint8Array,
  ) {}

  /** Bigger than an 800K disk, in whole blocks, and no bigger than ProDOS can use. */
  static isDiskSize(size: number): boolean {
    return size > DISK35_BYTES && size % BLOCK_BYTES === 0 && size / BLOCK_BYTES <= MAX_HARD_DISK_BLOCKS;
  }

  static fromImage(name: string, data: Uint8Array): HardDisk {
    if (!HardDisk.isDiskSize(data.length)) {
      throw new Error(`${name} is ${data.length.toLocaleString('en')} bytes, which isn't a hard disk image of up to 32 MB in 512-byte blocks.`);
    }
    return new HardDisk(name, data.slice());
  }

  get blocks(): number {
    return this.data.length / BLOCK_BYTES;
  }

  block(index: number): Uint8Array {
    return this.data.subarray(index * BLOCK_BYTES, (index + 1) * BLOCK_BYTES);
  }

  get extension(): string {
    return '.hdv';
  }

  get savesCompletely(): boolean {
    return true;
  }

  toImage(): Uint8Array {
    return this.data.slice();
  }
}
