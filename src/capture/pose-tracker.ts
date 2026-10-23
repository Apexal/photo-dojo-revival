import { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { NormalizedLandmark } from "../shared/fighter-model";
import { POSE_MODEL_URL, VISION_FILESET, loadModelBytes, withDelegateFallback, type DownloadProgress } from "./vision-runtime";

/** Live detection throttle; slower phones can't keep up with every video frame. */
export const LIVE_DETECTION_HZ = 15;

type ImageInput = HTMLCanvasElement | OffscreenCanvas | ImageBitmap | HTMLVideoElement;

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
  private stillLandmarker: PoseLandmarker | null = null;
  private lastTimestamp = -1;
  private lastDetectionAt = -Infinity;

  private constructor(private readonly videoLandmarker: PoseLandmarker, private readonly model: Uint8Array<ArrayBuffer>) {}

  /** `onProgress` reports the model download (instant from the model cache on later visits). */
  static async create(onProgress?: DownloadProgress): Promise<PoseTracker> {
    const model = await loadModelBytes(POSE_MODEL_URL, onProgress);
    const [video, still] = await Promise.all([PoseTracker.createLandmarker("VIDEO", model), PoseTracker.createLandmarker("IMAGE", model)]);
    const tracker = new PoseTracker(video, model);
    tracker.stillLandmarker = still;
    warmUp(still);
    return tracker;
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

  /** Landmarks for a still frame. */
  async detectStill(image: ImageInput): Promise<NormalizedLandmark[] | null> {
    this.stillLandmarker ??= await PoseTracker.createLandmarker("IMAGE", this.model);
    return toLandmarks(this.stillLandmarker.detect(image as HTMLCanvasElement));
  }

  close(): void {
    this.videoLandmarker.close();
    this.stillLandmarker?.close();
  }
}
