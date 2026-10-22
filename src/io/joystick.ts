import { PADDLE_CENTRE } from '../iigs';

/** Where the joystick goes: the game port's paddle timers and pushbuttons. */
export interface GamePort {
  readonly paddles: number[];
  readonly buttons: boolean[];
}

export const Joy = {
  Up: 0x01,
  Down: 0x02,
  Left: 0x04,
  Right: 0x08,
  Fire: 0x10,
  Fire2: 0x20,
} as const;

/** What one source (the keyboard, a gamepad) is doing: digital directions and buttons, and an analogue stick. */
export interface StickReading {
  bits: number;
  /** -1 (left, up) to 1 (right, down); 0 when the source has no stick or it's centred. */
  x: number;
  y: number;
}

/** -1 to 1 as a paddle value: 0 at the left (or top), 127 centred, 255 at the right. */
function axisToPaddle(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(PADDLE_CENTRE + clamped * (clamped < 0 ? PADDLE_CENTRE : 255 - PADDLE_CENTRE));
}

/**
 * The joystick: two paddle timers (X and Y, 0-255) and two buttons,
 * fed by any number of sources. A direction pushes its axis all the way;
 * otherwise a gamepad's stick gives its position.
 */
export class Joystick {
  private readonly sources = new Map<string, StickReading>();

  set(source: string, reading: StickReading): void {
    this.sources.set(source, reading);
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  /** Puts the combined position on paddles 0 and 1, and the buttons on pushbuttons 0 and 1. */
  apply(port: GamePort): void {
    let bits = 0;
    let x = 0;
    let y = 0;
    for (const reading of this.sources.values()) {
      bits |= reading.bits;
      if (Math.abs(reading.x) > Math.abs(x)) x = reading.x;
      if (Math.abs(reading.y) > Math.abs(y)) y = reading.y;
    }
    if (bits & Joy.Left) x = -1;
    else if (bits & Joy.Right) x = 1;
    if (bits & Joy.Up) y = -1;
    else if (bits & Joy.Down) y = 1;
    port.paddles[0] = axisToPaddle(x);
    port.paddles[1] = axisToPaddle(y);
    port.buttons[0] = (bits & Joy.Fire) !== 0;
    port.buttons[1] = (bits & Joy.Fire2) !== 0;
  }
}
