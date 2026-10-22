/** $C025, the modifier keys. */
export const enum Modifier {
  Shift = 0x01,
  Control = 0x02,
  CapsLock = 0x04,
  Repeat = 0x08,
  Keypad = 0x10,
  Option = 0x40,
  Command = 0x80,
}

/** $C027's interrupt enables (the only bits software can write). */
const STATUS_ENABLES = 0x54;
const STATUS_MOUSE_FULL = 0x80;
const STATUS_MOUSE_INT = 0x40;
const STATUS_DATA_FULL = 0x20;
const STATUS_DATA_INT = 0x10;
const STATUS_MOUSE_Y = 0x02;

/** A response byte reporting Ctrl-Command-Esc: the desk accessory menu was asked for. */
const DESK_ACCESSORY_REQUEST = 0x20;

/** How many data bytes follow each command (the rest have none). */
function commandLength(command: number, romVersion: number): number {
  switch (command) {
    case 0x04: case 0x05: case 0x11: return 1;
    case 0x06: return 3;
    case 0x07: return romVersion >= 3 ? 8 : 4;
    case 0x08: case 0x09: case 0x12: case 0x13: return 2;
  }
  // Listen: two bytes for a device's register.
  return command >= 0x80 && command < 0xc0 ? 2 : 0;
}

/**
 * The ADB GLU and the keyboard microcontroller behind it. The keyboard turns
 * up as on the IIe ($C000 and $C010), with the modifier keys in $C025; the
 * firmware sends the microcontroller commands through $C026 and reads their
 * answers back from it, with $C027 saying when one is waiting and holding the
 * interrupt enables. The mouse reports its movement through $C024.
 */
export class Adb {
  keyLatch = 0;
  keyStrobe = false;
  anyKeyDown = false;
  modifiers = 0;
  /** The interrupt enables of $C027. */
  enables = 0;
  /** The microcontroller's modes and configuration bytes (repeat rates, layout, language). */
  modes = 0;
  readonly config = [0x00, 0x00, 0x00];
  /** The microcontroller's own RAM, which the firmware can read and write. */
  readonly ram = new Uint8Array(256);
  mouseX = 0;
  mouseY = 0;
  mouseButton = false;
  /** Whether the next $C024 read is the Y movement. */
  private mouseYNext = false;
  private mouseFull = false;
  private responses: number[] = [];
  private command = -1;
  private commandData: number[] = [];

  constructor(public romVersion: number) {}

  reset(): void {
    this.responses = [];
    this.command = -1;
    this.commandData = [];
    this.enables = 0;
  }

  /** The microcontroller wants the CPU's attention. */
  get irq(): boolean {
    return (
      ((this.enables & STATUS_DATA_INT) !== 0 && this.responses.length !== 0) ||
      ((this.enables & STATUS_MOUSE_INT) !== 0 && this.mouseFull)
    );
  }

  /** $C024-$C027 read. */
  read(reg: number): number {
    switch (reg) {
      case 0x24: return this.readMouse();
      case 0x25: return this.modifiers;
      case 0x26: return this.responses.shift() ?? 0;
      default:
        return (
          (this.mouseFull ? STATUS_MOUSE_FULL : 0) |
          (this.responses.length ? STATUS_DATA_FULL : 0) |
          (this.mouseYNext ? STATUS_MOUSE_Y : 0) |
          this.enables
        );
    }
  }

  /** $C026 and $C027 written. */
  write(reg: number, value: number): void {
    if (reg === 0x27) this.enables = value & STATUS_ENABLES;
    else if (reg === 0x26) this.receive(value);
  }

  private receive(byte: number): void {
    if (this.command < 0) {
      this.command = byte;
      this.commandData = [];
    } else {
      this.commandData.push(byte);
    }
    if (this.commandData.length < commandLength(this.command, this.romVersion)) return;
    const command = this.command;
    this.command = -1;
    this.execute(command, this.commandData);
  }

  private execute(command: number, data: number[]): void {
    switch (command) {
      case 0x01: // Abort
      case 0x02: // Reset the keyboard microcontroller
      case 0x10: // Reset the system
      case 0x40: // Reset ADB
        this.responses = [];
        break;
      case 0x03: // Flush the keyboard buffer
        this.keyStrobe = false;
        break;
      case 0x04: this.modes |= data[0]; break;
      case 0x05: this.modes &= ~data[0]; break;
      case 0x06: this.config.splice(0, 3, ...data); break;
      case 0x07: // Sync: the modes and configuration together
        this.modes = data[0];
        this.config.splice(0, 3, ...data.slice(1, 4));
        break;
      case 0x08: this.ram[data[0]] = data[1]; break;
      case 0x09: this.responses.push(this.ram[data[0]]); break;
      case 0x0a: this.responses.push(this.modes); break;
      case 0x0b: this.responses.push(...this.config); break;
      case 0x0c: this.responses.push(0); break; // No errors
      case 0x0d: this.responses.push(this.romVersion >= 3 ? 6 : 5); break;
      case 0x0e: // The character sets and keyboard layouts available: just the US ones
      case 0x0f:
        this.responses.push(1, 0);
        break;
      case 0x11: break; // Send an ADB keycode
      default:
        // Talk to a device's register: only the keyboard (address 2) and mouse (3) are there.
        if (command >= 0xc0) this.talk(command & 0x0f, (command >> 4) & 3);
        break;
    }
  }

  private talk(address: number, register: number): void {
    if (address !== 2 && address !== 3) return;
    // Register 3: the device's address and its handler (the standard keyboard and mouse are 1 and 2).
    if (register === 3) this.responses.push(0x60 | address, address === 2 ? 1 : 2);
    else this.responses.push(0, 0);
  }

  /** $C024: the mouse's X movement then its Y, each 7 bits signed, with the button in bit 7. */
  private readMouse(): number {
    const delta = Math.max(-64, Math.min(63, this.mouseYNext ? this.mouseY : this.mouseX));
    if (this.mouseYNext) {
      this.mouseY -= delta;
      this.mouseFull = this.mouseX !== 0 || this.mouseY !== 0;
    } else {
      this.mouseX -= delta;
    }
    this.mouseYNext = !this.mouseYNext;
    return (this.mouseButton ? 0 : 0x80) | (delta & 0x7f);
  }

  /** The mouse moved or its button changed. */
  moveMouse(dx: number, dy: number, button: boolean): void {
    this.mouseX += dx;
    this.mouseY += dy;
    this.mouseButton = button;
    this.mouseFull = true;
  }

  /** A key typed: its ASCII code in the latch with the strobe set, and the modifiers as they were. */
  pressKey(code: number, modifiers: number): void {
    this.modifiers = modifiers;
    if ((modifiers & (Modifier.Control | Modifier.Command)) === (Modifier.Control | Modifier.Command) && code === 0x1b) {
      this.responses.push(DESK_ACCESSORY_REQUEST);
      return;
    }
    this.keyLatch = code & 0x7f;
    this.keyStrobe = true;
  }
}
