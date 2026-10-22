import { CLOCK_HZ, Iigs, type Roms } from './iigs';
import type { Screen } from './render/screen';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;
/** While warping, each animation frame emulates for this long. */
const WARP_BUDGET_MS = 12;
const WARP_SLICE_CYCLES = 20_000;

/** Glues the IIgs to the screen and the speakers, and runs it in step with real time. */
export class Emulator {
  readonly iigs: Iigs;
  /** Run flat out while a disk is being read or written. */
  warpWhileLoading = true;
  private clockDebt = 0;
  private warping = false;

  constructor(roms: Roms, screen: Screen) {
    this.iigs = new Iigs(roms);
    this.iigs.video.onFrame = (framebuffer) => screen.capture(framebuffer);
  }

  get loading(): boolean {
    return this.iigs.diskBusy();
  }

  get warped(): boolean {
    return this.warping;
  }

  /** Forgets time owed, e.g. after a pause, so the machine doesn't race to catch up. */
  resetTiming(): void {
    this.clockDebt = 0;
  }

  /** Runs the IIgs for `elapsedMs` of real time, or as much as fits in a frame while warping. */
  run(elapsedMs: number): void {
    const iigs = this.iigs;
    this.warping = this.warpWhileLoading && this.loading;
    if (this.warping) {
      const stopAt = performance.now() + WARP_BUDGET_MS;
      while (performance.now() < stopAt && this.loading) iigs.runCycles(WARP_SLICE_CYCLES);
      this.clockDebt = 0;
      return;
    }
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * CLOCK_HZ) / 1000;
    this.clockDebt -= iigs.runCycles(Math.floor(this.clockDebt));
  }

  takeAudioSamples(): Float32Array {
    return this.iigs.audio.takeSamples();
  }
}
