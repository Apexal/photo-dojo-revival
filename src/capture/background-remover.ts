import type { InferenceSession, Tensor } from "onnxruntime-web";
import type { NormalizedLandmark } from "../shared/fighter-model";
import { MODEL_SIZE, applyAlpha, keepPerson, personCropRect, resampleFloat, stretchToUnit, toModelInput, type Rect } from "./matting";
import { createCanvas, context2d, toPixelLandmarks } from "./sprite-normalizer";
import { MATTING_MODEL_FP16_URL, MATTING_MODEL_URL, ORT_RUNTIME_BASE, ORT_WASM_URL, loadModelBytes, type DownloadProgress } from "./vision-runtime";

type Ort = typeof import("onnxruntime-web");
export type MattingBackend = "webgpu" | "wasm";

export interface MatteDebug {
  rect: Rect;
  backend: MattingBackend;
  /** Inference time, ms. */
  inferenceMs: number;
  /** The model's alpha (0..1) at crop size, before keeping only the person. */
  modelAlpha: Float32Array;
  /** Final crop alpha (0..255). */
  alpha: Uint8ClampedArray;
}

/** iPhone, or iPad (which reports itself as a Mac with touch). Every iOS browser is Safari's engine underneath. */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/** Whether WebGPU can run the half-precision model (it needs the shader-f16 feature). */
async function gpuHasF16(): Promise<boolean> {
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter?.features.has("shader-f16") ?? false;
  } catch {
    return false;
  }
}

/**
 * Which model on which backend, in order of preference. The fp16 model needs about half the memory on
 * WebGPU (iPhones ran out of it with fp32), but on WASM it's several times slower than fp32, so WASM always gets fp32.
 */
async function backendPlan(): Promise<{ backend: MattingBackend; url: string }[]> {
  const wasm = { backend: "wasm" as const, url: MATTING_MODEL_URL };
  if (typeof navigator === "undefined" || !("gpu" in navigator)) return [wasm];
  const fp16 = MATTING_MODEL_FP16_URL && (await gpuHasF16());
  return [{ backend: "webgpu", url: fp16 ? MATTING_MODEL_FP16_URL : MATTING_MODEL_URL }, wasm];
}

/**
 * Background removal for full-body captures: ISNet on a crop around the
 * person, then only what's connected to the skeleton is kept (matting.ts).
 * Runs on WebGPU where the browser has it, otherwise on WASM (much slower).
 */
export class BackgroundRemover {
  private constructor(private readonly ort: Ort, private readonly session: InferenceSession, readonly backend: MattingBackend) {}

  /**
   * `onProgress` reports the model download (instant from the model cache on later visits), `onWasmProgress` ONNX Runtime's binary.
   * Downloads start at once; the session is only built once `after` settles, so it doesn't land on top of
   * the pose models being built (memory peaks then, and iOS kills tabs that go over).
   */
  static async create(onProgress?: DownloadProgress, onWasmProgress?: DownloadProgress, after?: Promise<unknown>): Promise<BackgroundRemover> {
    const plan = await backendPlan();
    const [ort, wasm, downloaded] = await Promise.all([
      import("onnxruntime-web"),
      loadModelBytes(ORT_WASM_URL, onWasmProgress),
      loadModelBytes(plan[0].url, onProgress),
      after?.catch(() => undefined),
    ]);
    let model: { url: string; bytes: Uint8Array } | null = { url: plan[0].url, bytes: downloaded };
    // The loader comes from the CDN; the binary from the model cache (it was downloaded with progress).
    ort.env.wasm.wasmPaths = ORT_RUNTIME_BASE;
    ort.env.wasm.wasmBinary = wasm;
    let lastError: unknown;
    for (const { backend, url } of plan) {
      try {
        // A fallback that wants the other model, or the same one after it was let go below: the model cache has it.
        if (model?.url !== url) model = { url, bytes: await loadModelBytes(url) };
        const session = await ort.InferenceSession.create(model.bytes, { executionProviders: [backend], graphOptimizationLevel: "all" });
        // ORT has its own copies now: let the downloaded bytes go before anything else allocates.
        model = null;
        ort.env.wasm.wasmBinary = undefined;
        const remover = new BackgroundRemover(ort, session, backend);
        // The first WebGPU run compiles shaders (seconds): do it while loading, not on the first snapshot.
        // On WASM a run costs as much as a real one, so don't. Nor on iOS, where a 1024² run on top of
        // everything loading is what pushes the tab over its memory limit: the first snapshot is slower there.
        if (backend === "webgpu" && !isIOS()) await remover.infer(new Float32Array(3 * MODEL_SIZE * MODEL_SIZE));
        console.info(`[matting] ISNet (${url === MATTING_MODEL_FP16_URL ? "fp16" : "fp32"}) on ${backend}`);
        return remover;
      } catch (err) {
        console.warn(`[matting] ${backend} unavailable`, err);
        lastError = err;
      }
    }
    throw lastError;
  }

  /** Model output (person probability) for one normalized 1024² input. */
  private async infer(input: Float32Array): Promise<Float32Array> {
    const feeds = { [this.session.inputNames[0]]: new this.ort.Tensor("float32", input, [1, 3, MODEL_SIZE, MODEL_SIZE]) };
    const results = await this.session.run(feeds);
    const output: Tensor = results[this.session.outputNames[0]];
    try {
      return (await output.getData()) as Float32Array;
    } finally {
      output.dispose();
    }
  }

  /**
   * The cut-out (RGBA, crop-sized, alpha = person) and the crop it covers.
   * `landmarks` are MediaPipe-normalized.
   */
  async cutout(frame: HTMLCanvasElement | OffscreenCanvas, landmarks: NormalizedLandmark[]): Promise<{ foreground: Uint8ClampedArray<ArrayBuffer>; debug: MatteDebug }> {
    const W = frame.width;
    const H = frame.height;
    const px = toPixelLandmarks(landmarks, W, H);
    const rect = personCropRect(px, W, H);

    const crop = createCanvas(rect.width, rect.height);
    const cropCtx = context2d(crop);
    cropCtx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const rgba = cropCtx.getImageData(0, 0, rect.width, rect.height).data;

    // The model takes a square: stretch the crop to fill it, as its reference code does.
    const square = createCanvas(MODEL_SIZE, MODEL_SIZE);
    const squareCtx = context2d(square);
    squareCtx.imageSmoothingQuality = "high";
    squareCtx.drawImage(crop, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const input = toModelInput(squareCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data);

    const started = performance.now();
    const output = await this.infer(input);
    const inferenceMs = Math.round(performance.now() - started);
    const modelAlpha = resampleFloat(stretchToUnit(output), MODEL_SIZE, MODEL_SIZE, rect.width, rect.height);

    const cropLandmarks = px.map((l) => ({ ...l, x: l.x - rect.x, y: l.y - rect.y }));
    const alpha = keepPerson(modelAlpha, rect.width, rect.height, cropLandmarks);
    return { foreground: applyAlpha(rgba, alpha), debug: { rect, backend: this.backend, inferenceMs, modelAlpha, alpha } };
  }

  close(): void {
    void this.session.release();
  }
}
