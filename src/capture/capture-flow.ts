import { SOUND_IDS, type SoundId } from "../shared/fighter-model";
import { CAPTURE_TARGETS, type CaptureTarget } from "../shared/pose-definitions";

export type CaptureMode = "friend" | "solo";

/** Pause after each capture before the next pose; solo mode gives time to reset. */
export const GRACE_MS: Record<CaptureMode, number> = { friend: 1200, solo: 3000 };

export type CaptureScreen =
  | { name: "intro" }
  | { name: "tips" }
  | { name: "loading" }
  /** Solo mode: photograph the empty room (for background subtraction) before the first pose. */
  | { name: "pose"; poseIndex: number; retake: boolean }
  /** `rough`: the cut-out failed the quality check and waits for "retake" or "keep". */
  | { name: "captured"; poseIndex: number; retake: boolean; rough: boolean }
  | { name: "review" }
  | { name: "sounds"; soundIndex: number }
  | { name: "preview" }
  | { name: "sending" }
  | { name: "sent" }
  | { name: "saved" }
  | { name: "sendFailed"; reason: string }
  | { name: "error"; message: string };

export type CaptureEvent =
  | { type: "selectMode"; mode: CaptureMode }
  | { type: "start" }
  | { type: "modelsReady" }
  /** The empty-room photo was taken, or skipped. */
  | { type: "poseCaptured" }
  | { type: "graceElapsed" }
  | { type: "captureFailed" }
  | { type: "captureRough" }
  | { type: "retakeRough" }
  | { type: "keepRough" }
  | { type: "retake"; targetKey: string }
  | { type: "reviewDone" }
  | { type: "soundDone" }
  | { type: "skipSound" }
  | { type: "skipAllSounds" }
  | { type: "finish" }
  | { type: "sent" }
  | { type: "saved" }
  | { type: "sendFailed"; reason: string }
  | { type: "retrySend" }
  | { type: "fail"; message: string }
  | { type: "restart" }
  /** Pick up a saved draft: straight to review if all main poses are in, else continue from the first missing one. */
  | { type: "resume"; mode: CaptureMode; roomCode: string | null; nextPoseIndex: number | null };

export interface CaptureFlowState {
  screen: CaptureScreen;
  mode: CaptureMode;
  /** A room code means the fighter is sent to a laptop; otherwise it's saved locally. */
  roomCode: string | null;
  /** Where the pose sequence continues after loading (resumed drafts). */
  resumeAt?: number | null;
}

export function initialCaptureFlow(roomCode: string | null): CaptureFlowState {
  return { screen: { name: "intro" }, mode: "friend", roomCode };
}

/** Index into CAPTURE_TARGETS (all fourteen poses, in capture order). */
export const targetAt = (index: number): CaptureTarget => CAPTURE_TARGETS[index];
const targetIndex = (key: string) => CAPTURE_TARGETS.findIndex((t) => t.key === key);
/** Screens that show the live camera (they share one DOM; only the HUD changes between them). */
export const isLiveScreen = (s: CaptureScreen): s is Extract<CaptureScreen, { name: "pose" | "captured" }> =>
  s.name === "pose" || s.name === "captured";

export const soundIdAt = (index: number): SoundId => SOUND_IDS[index];

/**
 * intro → tips → loading → pose 1..12 (each: pose → captured, or back to pose if it came out rough) → review → sounds 1..3 → preview → send/save.
 * Pure; unknown events for the current screen leave the state unchanged.
 */
export function captureFlowReducer(state: CaptureFlowState, event: CaptureEvent): CaptureFlowState {
  const s = state.screen;
  const to = (screen: CaptureScreen): CaptureFlowState => ({ ...state, screen });

  if (event.type === "fail") return to({ name: "error", message: event.message });
  if (event.type === "restart") return initialCaptureFlow(state.roomCode);

  switch (s.name) {
    case "intro":
      if (event.type === "selectMode") return { ...state, mode: event.mode, screen: { name: "tips" } };
      if (event.type === "resume") {
        const resumed = { ...state, mode: event.mode, roomCode: state.roomCode ?? event.roomCode };
        return event.nextPoseIndex === null
          ? { ...resumed, screen: { name: "review" } }
          : { ...resumed, resumeAt: event.nextPoseIndex, screen: { name: "tips" } };
      }
      break;
    case "tips":
      if (event.type === "start") return to({ name: "loading" });
      break;
    case "loading":
      if (event.type === "modelsReady") return { ...state, resumeAt: null, screen: { name: "pose", poseIndex: state.resumeAt ?? 0, retake: false } };
      break;
    case "pose":
      if (event.type === "poseCaptured") return to({ ...s, name: "captured", rough: false });
      break;
    case "captured": {
      const again: CaptureScreen = { name: "pose", poseIndex: s.poseIndex, retake: s.retake };
      if (event.type === "captureFailed") return to(again);
      if (event.type === "captureRough") return to({ ...s, rough: true });
      if (s.rough) {
        if (event.type === "retakeRough") return to(again);
        if (event.type === "keepRough") return to(nextAfter(s));
      } else if (event.type === "graceElapsed") {
        return to(nextAfter(s));
      }
      break;
    }
    case "review":
      if (event.type === "retake" && targetIndex(event.targetKey) >= 0) return to({ name: "pose", poseIndex: targetIndex(event.targetKey), retake: true });
      if (event.type === "reviewDone") return to({ name: "sounds", soundIndex: 0 });
      break;
    case "sounds":
      if (event.type === "soundDone" || event.type === "skipSound") {
        return s.soundIndex + 1 >= SOUND_IDS.length ? to({ name: "preview" }) : to({ name: "sounds", soundIndex: s.soundIndex + 1 });
      }
      if (event.type === "skipAllSounds") return to({ name: "preview" });
      break;
    case "preview":
      if (event.type === "retake" && targetIndex(event.targetKey) >= 0) return to({ name: "pose", poseIndex: targetIndex(event.targetKey), retake: true });
      if (event.type === "finish") return to(state.roomCode ? { name: "sending" } : { name: "saved" });
      break;
    case "sending":
      if (event.type === "sent") return to({ name: "sent" });
      if (event.type === "sendFailed") return to({ name: "sendFailed", reason: event.reason });
      break;
    case "sendFailed":
      if (event.type === "retrySend") return to({ name: "sending" });
      if (event.type === "saved") return to({ name: "saved" });
      break;
    default:
      break;
  }
  return state;
}

/** Where to go after a pose is captured. */
function nextAfter(s: { poseIndex: number; retake: boolean }): CaptureScreen {
  if (s.retake) return { name: "review" };
  const next = s.poseIndex + 1;
  return next < CAPTURE_TARGETS.length ? { name: "pose", poseIndex: next, retake: false } : { name: "review" };
}
