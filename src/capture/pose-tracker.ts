import { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { NormalizedLandmark } from "../shared/fighter-model";
import { POSE_MODEL_URL, VISION_FILESET, loadModelBytes, prefetchWasm, withDelegateFallback, type DownloadProgress } from "./vision-runtime";

/** Live detection throttle: the heavy model can't keep up with every video frame on every computer. */
export const LIVE_DETECTION_HZ = 15;

/** The first inference compiles shaders / spins up WASM (seconds); do it before the first snapshot. */
function warmUp(landmarker: PoseLandmarker): void {
  const blank = document.createElement("canvas");
  blank.width = blank.height = 64;
  landmarker.detect(blank).close();
}

function toLandmarks(result: { landmarks: { x: number; y: number; visibility?: number }[][] }): NormalizedLandmark[] | null {
  const person = result.landmarks[0];
  if (!person) return null;
  return person.map((l) => ({ x: l.x, y: l.y, visibility: l.visibility ?? 1 }));
}

/**
 * PoseLandmarker wrapper. Live tracking uses VIDEO mode; the still capture
 * re-runs detection on the full-resolution frame in IMAGE mode for clean keypoints.
 * Both use the heavy model (see vision-runtime.ts). Landmarks are MediaPipe-normalized (0..1).
 */
export class PoseTracker {
  private lastTimestamp = -1;
  private lastDetectionAt = -Infinity;

  private constructor(private readonly videoLandmarker: PoseLandmarker, private readonly stillLandmarker: PoseLandmarker) {}

  /**
   * `onProgress` reports the model download (instant from the model cache on
   * later visits), `onWasmProgress` the MediaPipe runtime's; both download at once.
   */
  static async create(onProgress?: DownloadProgress, onWasmProgress?: DownloadProgress): Promise<PoseTracker> {
    const [model] = await Promise.all([loadModelBytes(POSE_MODEL_URL, onProgress), prefetchWasm(onWasmProgress)]);
    const [video, still] = await Promise.all([PoseTracker.createLandmarker("VIDEO", model), PoseTracker.createLandmarker("IMAGE", model)]);
    warmUp(still);
    return new PoseTracker(video, still);
  }

  private static createLandmarker(runningMode: "VIDEO" | "IMAGE", model: Uint8Array<ArrayBuffer>): Promise<PoseLandmarker> {
    return withDelegateFallback((delegate) =>
      PoseLandmarker.createFromOptions(VISION_FILESET, {
        // A copy each: MediaPipe may take over the buffer it's given.
        baseOptions: { modelAssetBuffer: model.slice(), delegate },
        runningMode,
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    );
  }

  /** Whether enough time has passed since the last live detection (throttled to ~15 Hz). */
  shouldDetect(nowMs: number): boolean {
    return nowMs - this.lastDetectionAt >= 1000 / LIVE_DETECTION_HZ - 1;
  }

  detectLive(video: HTMLVideoElement, nowMs: number): NormalizedLandmark[] | null {
    // VIDEO mode requires strictly increasing timestamps.
    const ts = Math.max(this.lastTimestamp + 1, Math.round(nowMs));
    this.lastTimestamp = ts;
    this.lastDetectionAt = nowMs;
    return toLandmarks(this.videoLandmarker.detectForVideo(video, ts));
  }

  /** Landmarks for a still frame (a fresh detection, no tracking from the live video). */
  detectStill(image: HTMLCanvasElement | OffscreenCanvas): NormalizedLandmark[] | null {
    return toLandmarks(this.stillLandmarker.detect(image as HTMLCanvasElement));
  }

  close(): void {
    this.videoLandmarker.close();
    this.stillLandmarker.close();
  }
}
