import { describe, expect, it } from "vitest";
import { holdToneFrequency, HOLD_TONE } from "../src/capture/hold-sound";
import { TRIM_PRE_ROLL_MS, leadingSilenceSamples } from "../src/shared/audio-trim";

const RATE = 48000;
const ms = (n: number) => Math.round((n / 1000) * RATE);

/** `silenceMs` of low noise, then a loud tone. */
function clip(silenceMs: number, noise = 0.005, totalMs = 1000): Float32Array {
  const out = new Float32Array(ms(totalMs));
  for (let i = 0; i < out.length; i++) {
    out[i] = i < ms(silenceMs) ? noise * Math.sin(i * 1.7) : 0.6 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  }
  return out;
}

describe("leading silence trim", () => {
  it("cuts silence up to the first loud window, keeping a short pre-roll", () => {
    const cut = leadingSilenceSamples([clip(400)], RATE);
    expect(cut).toBeGreaterThan(ms(400 - TRIM_PRE_ROLL_MS - 6));
    expect(cut).toBeLessThanOrEqual(ms(400 - TRIM_PRE_ROLL_MS));
  });

  it("treats quiet room noise below the threshold as silence", () => {
    expect(leadingSilenceSamples([clip(300, 0.015)], RATE)).toBeGreaterThan(ms(270));
  });

  it("leaves clips that start immediately alone", () => {
    expect(leadingSilenceSamples([clip(0)], RATE)).toBe(0);
    expect(leadingSilenceSamples([clip(10)], RATE)).toBe(0); // within the pre-roll
  });

  it("leaves fully silent and empty clips alone", () => {
    expect(leadingSilenceSamples([new Float32Array(ms(500))], RATE)).toBe(0);
    expect(leadingSilenceSamples([new Float32Array(0)], RATE)).toBe(0);
  });

  it("uses a level relative to the clip's peak, so a quiet voice still trims", () => {
    // Whole clip scaled way down: absolute threshold alone would miss the onset.
    const quiet = clip(250).map((v, i) => (i < ms(250) ? v * 0.1 : v * 0.05));
    expect(leadingSilenceSamples([quiet], RATE, { absoluteThreshold: 0 })).toBeGreaterThan(ms(220));
  });

  it("considers every channel", () => {
    const left = new Float32Array(ms(1000));
    expect(leadingSilenceSamples([left, clip(200)], RATE)).toBeGreaterThan(ms(170));
  });
});

describe("hold tone", () => {
  it("sweeps exponentially from the start to the end note", () => {
    expect(holdToneFrequency(0)).toBeCloseTo(HOLD_TONE.startHz);
    expect(holdToneFrequency(1)).toBeCloseTo(HOLD_TONE.endHz);
    expect(holdToneFrequency(0.5)).toBeCloseTo(Math.sqrt(HOLD_TONE.startHz * HOLD_TONE.endHz));
    expect(holdToneFrequency(2)).toBeCloseTo(HOLD_TONE.endHz);
  });
});
