/** Rising "charging" sweep, start to end of the hold. */
export const HOLD_TONE = { startHz: 220, endHz: 880, pulseStartHz: 6, pulseEndHz: 18, volume: 0.18 } as const;

/** Exponential sweep, so each step sounds equally far apart. `progress` is 0..1. */
export function holdToneFrequency(progress: number, from: number = HOLD_TONE.startHz, to: number = HOLD_TONE.endHz): number {
  const p = Math.min(1, Math.max(0, progress));
  return from * (to / from) ** p;
}

/**
 * Audio feedback for the pose hold, so the person posing doesn't have to look
 * at the screen: a rising, pulsing tone for the whole hold, cut short if the
 * pose breaks, and a ding when the snapshot is taken.
 */
export class HoldSound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private active: { stop(at: number): void; gain: GainNode } | null = null;

  /** Browsers only start audio after a user gesture; call this from one. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Begin the sweep; it reaches the top note exactly when the hold completes. */
  start(durationMs: number): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx) return;
    this.cancel();
    const now = ctx.currentTime;
    const end = now + durationMs / 1000;

    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(holdToneFrequency(0), now);
    osc.frequency.exponentialRampToValueAtTime(holdToneFrequency(1), end);

    // Tremolo that speeds up: the "loading" pulse.
    const pulse = ctx.createOscillator();
    pulse.frequency.setValueAtTime(HOLD_TONE.pulseStartHz, now);
    pulse.frequency.linearRampToValueAtTime(HOLD_TONE.pulseEndHz, end);
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.5;
    const tremolo = ctx.createGain();
    tremolo.gain.value = 0.5;
    pulse.connect(pulseDepth).connect(tremolo.gain);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(HOLD_TONE.volume, now + 0.03);
    osc.connect(tremolo).connect(gain).connect(ctx.destination);
    osc.start(now);
    pulse.start(now);
    // Safety stop shortly after the expected end, in case nobody calls complete/cancel.
    osc.stop(end + 0.5);
    pulse.stop(end + 0.5);
    this.active = {
      gain,
      stop: (at) => {
        try { osc.stop(at); pulse.stop(at); } catch { /* already stopped */ }
      },
    };
  }

  /** Pose broken: fade out quickly. */
  cancel(): void {
    const ctx = this.ctx;
    const active = this.active;
    this.active = null;
    if (!ctx || !active) return;
    const now = ctx.currentTime;
    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setValueAtTime(active.gain.gain.value, now);
    active.gain.gain.linearRampToValueAtTime(0, now + 0.04);
    active.stop(now + 0.05);
  }

  /** Snapshot taken: end the sweep and ding. */
  complete(): void {
    this.cancel();
    const ctx = this.ctx;
    if (!this.enabled || !ctx) return;
    const now = ctx.currentTime;
    for (const [freq, delay] of [[1318.5, 0], [1760, 0.07]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(0.25, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + 0.4);
    }
  }
}
