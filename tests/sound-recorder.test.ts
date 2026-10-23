import { describe, expect, it } from "vitest";
import { MAX_GAIN, QUIET_PEAK, TARGET_PEAK, computePeakGain, measureLevel, meterPosition, pickRecorderMimeType } from "../src/capture/sound-recorder";

describe("sound recorder helpers", () => {
  it("prefers webm/opus and falls back to mp4 (Safari)", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecorderMimeType(() => false)).toBe("");
  });

  it("computes the gain that brings the peak to 0.9", () => {
    expect(computePeakGain([new Float32Array([0.1, -0.45, 0.2])])).toBeCloseTo(2);
    expect(computePeakGain([new Float32Array([0.1]), new Float32Array([-0.9])])).toBeCloseTo(1);
  });

  it("caps gain and leaves silence alone", () => {
    expect(computePeakGain([new Float32Array([0.001])])).toBe(10);
    expect(computePeakGain([new Float32Array([0, 0])])).toBe(1);
  });

  it("measures RMS and peak", () => {
    expect(measureLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toEqual({ rms: 0.5, peak: 0.5 });
    expect(measureLevel(new Float32Array([0, -0.8]))).toMatchObject({ peak: expect.closeTo(0.8) });
    expect(measureLevel(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
  });

  it("maps levels onto a dB meter", () => {
    expect(meterPosition(1)).toBe(1);
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(10 ** (-24 / 20))).toBeCloseTo(0.5);
    expect(meterPosition(1e-6)).toBe(0);
  });

  it("'too quiet' is exactly where normalization runs out of gain", () => {
    expect(computePeakGain([new Float32Array([QUIET_PEAK])])).toBeCloseTo(MAX_GAIN);
    expect(QUIET_PEAK * MAX_GAIN).toBeCloseTo(TARGET_PEAK);
  });
});
