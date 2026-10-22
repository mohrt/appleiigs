import type { Adb } from './adb';

/**
 * The browser's mouse as the IIgs's ADB mouse. Clicking the screen captures
 * the pointer (Esc lets it go), after which the mouse's movement and its
 * button go to the IIgs.
 */
export class AdbMouse {
  /** Called when the pointer is captured or let go. */
  onCaptureChange: (captured: boolean) => void = () => {};
  private button = false;

  constructor(
    private readonly adb: Adb,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  get captured(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  attach(): void {
    const canvas = this.canvas;
    canvas.addEventListener('mousedown', (event) => {
      if (!this.captured) {
        void canvas.requestPointerLock()?.catch(() => {});
        return;
      }
      if (event.button === 0) this.setButton(true);
    });
    window.addEventListener('mouseup', (event) => {
      if (event.button === 0 && this.button) this.setButton(false);
    });
    document.addEventListener('mousemove', (event) => {
      if (this.captured) this.adb.moveMouse(event.movementX, event.movementY, this.button);
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.captured && this.button) this.setButton(false);
      this.onCaptureChange(this.captured);
    });
  }

  private setButton(down: boolean): void {
    this.button = down;
    this.adb.moveMouse(0, 0, down);
  }
}
