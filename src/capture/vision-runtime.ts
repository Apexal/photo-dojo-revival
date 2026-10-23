import type { FilesetResolver } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

/** The WASM runtime is bundled with the site so it is served from our own origin. */
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export const VISION_FILESET: WasmFileset = { wasmLoaderPath, wasmBinaryPath };

/**
 * The heavy pose model (~31 MB) for both live tracking and stills: landmark
 * accuracy (hands, feet, the far-side limbs) decides how good a fighter looks
 * and plays, so it's worth the download and the slower live frame rate.
 */
export const POSE_MODEL_URL =
  import.meta.env.VITE_POSE_MODEL_URL ||
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";

/**
 * ISNet (IS-Net/DIS general use, Apache-2.0, ~179 MB): a 1024² background-removal
 * model, far better at full-body cut-outs than MediaPipe's 256² selfie
 * segmenters, and a plain CNN, so it runs on both WebGPU and WASM. Built by
 * scripts/build-matting-model.py; the dev server serves it from models/.
 */
// `||`: CI passes unset repository variables through as empty strings.
export const MATTING_MODEL_URL = import.meta.env.VITE_MATTING_MODEL_URL || "/models/isnet-general-use-webgpu.onnx";

/** Keep in step with the onnxruntime-web version in package.json (a test checks). */
export const ORT_VERSION = "1.30.0";

/**
 * ONNX Runtime's WebGPU + WASM runtime (a small loader and a ~28 MB binary).
 * Loaded from the CDN, not bundled: the binary is over Cloudflare Pages' 25 MiB
 * per-file limit (see the resolve condition in vite.config.ts).
 */
export const ORT_RUNTIME_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_WASM_URL = `${ORT_RUNTIME_BASE}ort-wasm-simd-threaded.jsep.wasm`;

/** Try the GPU delegate, fall back to CPU (WASM) if it isn't available. */
export async function withDelegateFallback<T>(create: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try {
    return await create("GPU");
  } catch (err) {
    console.warn("[vision] GPU delegate unavailable, using CPU", err);
    return create("CPU");
  }
}

/** Bytes downloaded so far / expected total (0 while unknown). */
export type DownloadProgress = (loaded: number, total: number) => void;

/** Model bytes are kept here across visits: the model CDN only allows an hour of HTTP caching. */
const MODEL_CACHE = "photodojo-models-v1";

async function openModelCache(): Promise<Cache | null> {
  try {
    return typeof caches !== "undefined" ? await caches.open(MODEL_CACHE) : null;
  } catch {
    return null; // not a secure context, or storage blocked
  }
}

/** Read a response body, reporting progress against its Content-Length. */
async function readWithProgress(response: Response, onProgress?: DownloadProgress): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(bytes.length, bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  // Filled in place (grown only if Content-Length was wrong), so a big model isn't held twice while it's assembled.
  let buffer = new Uint8Array(total);
  let loaded = 0;
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > buffer.length) {
      const grown = new Uint8Array(Math.max(buffer.length * 2, loaded + value.length));
      grown.set(buffer.subarray(0, loaded));
      buffer = grown;
    }
    buffer.set(value, loaded);
    loaded += value.length;
    onProgress?.(loaded, Math.max(total, loaded));
  }
  const bytes = loaded === buffer.length ? buffer : buffer.slice(0, loaded);
  onProgress?.(loaded, loaded);
  return bytes;
}

/** Download a model (or take it from the model cache), with progress. */
export async function loadModelBytes(url: string, onProgress?: DownloadProgress): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await openModelCache();
  const cached = await cache?.match(url).catch(() => undefined);
  if (cached) return readWithProgress(cached, onProgress);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url.split("/").pop()} (HTTP ${response.status})`);
  const bytes = await readWithProgress(response, onProgress);
  await cache?.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } })).catch((err) => {
    console.warn("[vision] couldn't cache model", err);
  });
  return bytes;
}

/**
 * Fetch the bundled WASM runtime ahead of MediaPipe so its download shows on
 * the progress bar; MediaPipe's own request then comes from the HTTP cache.
 */
export async function prefetchWasm(onProgress?: DownloadProgress): Promise<void> {
  const response = await fetch(VISION_FILESET.wasmBinaryPath);
  if (response.ok) await readWithProgress(response, onProgress);
}

/**
 * Combined progress over several downloads. Sizes that aren't known yet use
 * an estimate, so the bar doesn't jump backwards when a big file starts.
 */
export class DownloadTracker {
  private readonly parts = new Map<string, { loaded: number; total: number }>();

  constructor(estimates: Record<string, number>, private readonly onChange: (fraction: number) => void) {
    for (const [key, total] of Object.entries(estimates)) this.parts.set(key, { loaded: 0, total });
  }

  reporter(key: string): DownloadProgress {
    return (loaded, total) => {
      const part = this.parts.get(key) ?? { loaded: 0, total: 0 };
      this.parts.set(key, { loaded, total: total || part.total });
      this.onChange(this.fraction);
    };
  }

  get fraction(): number {
    let loaded = 0, total = 0;
    for (const p of this.parts.values()) {
      loaded += Math.min(p.loaded, p.total || p.loaded);
      total += p.total || p.loaded;
    }
    return total ? loaded / total : 0;
  }
}
