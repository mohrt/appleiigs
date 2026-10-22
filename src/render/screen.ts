import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../video/video';

/** The picture's shape on a monitor: the screen and its border fill a 4:3 tube. */
export const SCREEN_ASPECT = 4 / 3;

/** Turns finished frames into canvas pixels: 704 dots wide (640 and the border), two rows per line. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private hasNewFrame = false;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    canvas.width = SCREEN_WIDTH;
    canvas.height = SCREEN_HEIGHT;
    this.image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  /** Copies a finished frame. */
  capture(framebuffer: Uint32Array): void {
    this.pixels.set(framebuffer);
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
