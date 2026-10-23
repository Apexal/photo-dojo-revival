import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MODEL_SIZE,
  REGION_ALPHA,
  applyAlpha,
  keepConnected,
  keepPerson,
  personCropRect,
  resampleFloat,
  skeletonPrior,
  stretchToUnit,
  toModelInput,
} from "../src/capture/matting";
import { LANDMARK } from "../src/shared/fighter-model";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";

vi.mock("@mediapipe/tasks-vision/vision_wasm_internal.js?url", () => ({ default: "/wasm.js" }));
vi.mock("@mediapipe/tasks-vision/vision_wasm_internal.wasm?url", () => ({ default: "/wasm.wasm" }));

const W = 512;
const H = 512;
const idle = buildStickFigureLandmarks("idle");
const at = (x: number, y: number) => Math.round(y) * W + Math.round(x);

describe("crop and prior", () => {
  it("crops around the person with margins, clamped to the frame", () => {
    const r = personCropRect(idle, W, H);
    const xs = idle.map((l) => l.x);
    expect(r.x).toBeLessThan(Math.min(...xs));
    expect(r.x + r.width).toBeGreaterThan(Math.max(...xs));
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(H);
  });

  it("the skeleton prior covers the body and is zero far away", () => {
    const prior = skeletonPrior(idle, W, H);
    const hip = idle[LANDMARK.leftHip];
    expect(prior[at(hip.x, hip.y)]).toBe(1);
    expect(prior[at(idle[LANDMARK.nose].x, idle[LANDMARK.nose].y)]).toBe(1);
    expect(prior[at(20, 20)]).toBe(0);
    expect(prior[at(500, 480)]).toBe(0);
  });
});

describe("keeping the person", () => {
  it("keeps only blobs connected to the seeds", () => {
    const m = new Uint8Array(10 * 10);
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) m[y * 10 + x] = 1; // body
    m[8 * 10 + 8] = 1; // stray blob
    const kept = keepConnected(m, 10, 10, [11]);
    expect(kept[0]).toBe(1);
    expect(kept[88]).toBe(0);
    expect(kept.reduce((s, v) => s + v, 0)).toBe(9);
  });

  const body = skeletonPrior(idle, W, H, { scale: 0.6, falloffScale: 0 }).map((v) => (v >= 1 ? 0.97 : 0));

  it("drops things the model found that aren't attached to the body, and keeps soft edges", () => {
    const alpha = Float32Array.from(body);
    for (let y = 400; y < 480; y++) for (let x = 10; x < 90; x++) alpha[y * W + x] = 0.9; // a lamp across the room
    const hip = idle[LANDMARK.leftHip];
    // A soft fringe (hair, motion blur) just outside the body.
    let fringe = -1;
    for (let x = Math.round(hip.x); x < W; x++) if (!body[at(x, hip.y)]) { fringe = at(x, hip.y); break; }
    alpha[fringe] = 0.3;
    const out = keepPerson(alpha, W, H, idle);
    expect(out[at(50, 440)]).toBe(0);
    expect(out[at(hip.x, hip.y)]).toBe(Math.round(0.97 * 255));
    expect(out[fringe]).toBe(Math.round(0.3 * 255));
  });

  it("drops faint haze below the region threshold that isn't connected", () => {
    const alpha = Float32Array.from(body);
    alpha[at(5, 5)] = REGION_ALPHA / 2;
    expect(keepPerson(alpha, W, H, idle)[at(5, 5)]).toBe(0);
  });

  it("trusts the model when the landmarks miss its matte entirely", () => {
    const alpha = new Float32Array(W * H);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) alpha[y * W + x] = 1;
    expect(keepPerson(alpha, W, H, idle)[at(10, 10)]).toBe(255);
  });

  it("puts the alpha into the crop's colours", () => {
    const rgba = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
    expect(Array.from(applyAlpha(rgba, Uint8ClampedArray.from([0, 200])))).toEqual([10, 20, 30, 0, 40, 50, 60, 200]);
  });
});

describe("model input and output", () => {
  it("turns RGBA into planar RGB centred on zero", () => {
    const rgba = Uint8ClampedArray.from([255, 0, 128, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const t = toModelInput(rgba, 2);
    expect(t.length).toBe(12);
    expect(t[0]).toBeCloseTo(0.5); // R plane, pixel 0
    expect(t[4 + 1]).toBeCloseTo(0.5); // G plane, pixel 1
    expect(t[8 + 0]).toBeCloseTo(128 / 255 - 0.5); // B plane, pixel 0
    expect(t[2]).toBeCloseTo(-0.5);
    expect(MODEL_SIZE).toBe(1024);
  });

  it("stretches the model's output to the full 0..1 range", () => {
    expect(Array.from(stretchToUnit([0.01, 0.5, 0.97]))).toEqual([0, expect.closeTo(0.51, 2), 1]);
    expect(Array.from(stretchToUnit([0.3, 0.3]))).toEqual([0, 0]);
  });

  it("resamples float masks bilinearly", () => {
    const up = resampleFloat(Float32Array.from([0, 1]), 2, 1, 4, 1);
    expect(Array.from(up)).toEqual([0, 0.25, 0.75, 1]);
  });

  it("loads the ONNX Runtime binary matching the installed onnxruntime-web", async () => {
    const { ORT_VERSION, ORT_WASM_URL } = await import("../src/capture/vision-runtime");
    const installed = JSON.parse(readFileSync("node_modules/onnxruntime-web/package.json", "utf8")).version;
    expect(ORT_VERSION).toBe(installed);
    expect(ORT_WASM_URL).toContain(`onnxruntime-web@${installed}/`);
  });
});
