const SPEAKER_GAIN = 0.25;
/** One oscillator at full volume playing a full-scale sample (127 * 255) comes out at about a third of full scale. */
const DOC_GAIN = 1 / 100_000;
/** A gentle high-pass that takes away DC (the speaker cone left pushed out). */
const DC_BLOCK = 0.995;

/**
 * Turns the speaker's clicks and the Ensoniq's output into stereo samples at
 * the audio device's rate. The speaker toggles whenever $C030 is touched; the
 * Ensoniq's level changes each time it passes over its oscillators. Each
 * sample averages both over the cycles the sample covers.
 */
export class AudioMixer {
  speakerLevel = -1;
  /** The Ensoniq's output, already scaled by the sound GLU's volume. */
  docLevel = 0;
  /** Runs the Ensoniq up to a cycle (it reports its levels through setDocLevel). */
  source: ((cycle: number) => void) | null = null;
  /** Cycle up to which samples have been made. */
  lastCycle = 0;
  private cyclesPerSample = 1_020_484 / 48_000;
  private sampleEnd = this.cyclesPerSample;
  private speakerSum = 0;
  private docSum = 0;
  private lastIn = 0;
  private lastOut = 0;
  private buffer = new Float32Array(8192);
  private length = 0;

  setRates(clockHz: number, sampleRate: number): void {
    this.cyclesPerSample = clockHz / sampleRate;
    this.sampleEnd = this.lastCycle + this.cyclesPerSample;
  }

  /** Restarts at `cycle` (after a reset or loading a state). */
  resync(cycle: number): void {
    this.lastCycle = cycle;
    this.sampleEnd = cycle + this.cyclesPerSample;
    this.speakerSum = this.docSum = 0;
  }

  toggleSpeaker(cycle: number): void {
    this.run(cycle);
    this.speakerLevel = -this.speakerLevel;
  }

  /** The Ensoniq's output changed at `cycle`. */
  setDocLevel(level: number, cycle: number): void {
    this.advanceTo(cycle);
    this.docLevel = level;
  }

  /** Makes the samples up to `cycle`. */
  run(cycle: number): void {
    this.source?.(cycle);
    this.advanceTo(cycle);
  }

  private advanceTo(cycle: number): void {
    if (cycle <= this.lastCycle) return;
    while (this.sampleEnd <= cycle) {
      this.advance(this.sampleEnd);
      this.emit();
      this.sampleEnd += this.cyclesPerSample;
    }
    this.advance(cycle);
  }

  private advance(cycle: number): void {
    const span = cycle - this.lastCycle;
    this.speakerSum += this.speakerLevel * span;
    this.docSum += this.docLevel * span;
    this.lastCycle = cycle;
  }

  private emit(): void {
    const speaker = (this.speakerSum / this.cyclesPerSample) * SPEAKER_GAIN;
    const doc = (this.docSum / this.cyclesPerSample) * DOC_GAIN;
    const value = Math.max(-1, Math.min(1, this.filter(speaker + doc)));
    this.speakerSum = this.docSum = 0;
    if (this.length + 2 > this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = value;
    this.buffer[this.length++] = value;
  }

  private filter(value: number): number {
    const out = value - this.lastIn + DC_BLOCK * this.lastOut;
    this.lastIn = value;
    this.lastOut = out;
    return out;
  }

  /** The samples made since the last call, interleaved left and right. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
