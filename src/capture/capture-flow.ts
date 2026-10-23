import type { ArchetypeId } from "../shared/archetypes";
import { SOUND_IDS, type SoundId } from "../shared/fighter-model";
import { CAPTURE_TARGET_COUNT, SIGNATURE_TARGET_INDEX, captureTargetsFor, type CaptureTarget } from "../shared/pose-definitions";

export type CaptureMode = "friend" | "solo";

/** Pause after each capture before the next pose; solo mode gives time to reset. */
export const GRACE_MS: Record<CaptureMode, number> = { friend: 1200, solo: 3000 };

export type CaptureScreen =
  | { name: "intro" }
  | { name: "tips" }
  | { name: "loading" }
  | { name: "pose"; poseIndex: number; retake: boolean }
  /** `rough`: the cut-out failed the quality check and waits for "retake" or "keep". */
  | { name: "captured"; poseIndex: number; retake: boolean; rough: boolean }
  /** Pick the archetype, just before its signature pose (`retake`: changing it from the review). */
  | { name: "archetype"; retake: boolean }
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
  | { type: "poseCaptured" }
  | { type: "graceElapsed" }
  | { type: "captureFailed" }
  | { type: "captureRough" }
  | { type: "retakeRough" }
  | { type: "keepRough" }
  | { type: "retake"; targetKey: string }
  | { type: "pickArchetype"; archetype: ArchetypeId }
  /** From the review: pick another archetype (and so retake the signature pose). */
  | { type: "changeArchetype" }
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
  | { type: "resume"; mode: CaptureMode; roomCode: string | null; archetype: ArchetypeId | null; nextPoseIndex: number | null };

export interface CaptureFlowState {
  screen: CaptureScreen;
  mode: CaptureMode;
  /** A room code means the fighter is sent to a laptop; otherwise it's saved locally. */
  roomCode: string | null;
  /** Where the pose sequence continues after loading (resumed drafts). */
  resumeAt?: number | null;
  /** Picked just before the signature pose; null until then. */
  archetype: ArchetypeId | null;
}

export function initialCaptureFlow(roomCode: string | null): CaptureFlowState {
  return { screen: { name: "intro" }, mode: "friend", roomCode, archetype: null };
}

/** The capture target at an index (all sixteen poses, in capture order); the signature pose needs the archetype. */
export function targetAt(index: number, archetype: ArchetypeId | null): CaptureTarget {
  if (index === SIGNATURE_TARGET_INDEX && !archetype) throw new Error("No archetype picked for the signature pose");
  return captureTargetsFor(archetype ?? "brawler")[index];
}
// Keys are the same for every archetype.
const targetIndex = (key: string) => captureTargetsFor("brawler").findIndex((t) => t.key === key);
/** Screens that show the live camera (they share one DOM; only the HUD changes between them). */
export const isLiveScreen = (s: CaptureScreen): s is Extract<CaptureScreen, { name: "pose" | "captured" }> =>
  s.name === "pose" || s.name === "captured";

export const soundIdAt = (index: number): SoundId => SOUND_IDS[index];

/**
 * intro → tips → loading → pose 1..16 (each: pose → captured, or back to pose if it came out rough; the archetype
 * is picked before the signature pose) → review → sounds 1..3 → preview → send/save.
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
        const resumed = { ...state, mode: event.mode, roomCode: state.roomCode ?? event.roomCode, archetype: event.archetype };
        return event.nextPoseIndex === null
          ? { ...resumed, screen: { name: "review" } }
          : { ...resumed, resumeAt: event.nextPoseIndex, screen: { name: "tips" } };
      }
      break;
    case "tips":
      if (event.type === "start") return to({ name: "loading" });
      break;
    case "loading":
      if (event.type === "modelsReady") return { ...state, resumeAt: null, screen: poseScreen(state, state.resumeAt ?? 0, false) };
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
        if (event.type === "keepRough") return to(nextAfter(state, s));
      } else if (event.type === "graceElapsed") {
        return to(nextAfter(state, s));
      }
      break;
    }
    case "archetype":
      if (event.type === "pickArchetype") {
        return { ...state, archetype: event.archetype, screen: { name: "pose", poseIndex: SIGNATURE_TARGET_INDEX, retake: s.retake } };
      }
      break;
    case "review":
      if (event.type === "retake" && targetIndex(event.targetKey) >= 0) return to(poseScreen(state, targetIndex(event.targetKey), true));
      if (event.type === "changeArchetype") return to({ name: "archetype", retake: true });
      if (event.type === "reviewDone") return to({ name: "sounds", soundIndex: 0 });
      break;
    case "sounds":
      if (event.type === "soundDone" || event.type === "skipSound") {
        return s.soundIndex + 1 >= SOUND_IDS.length ? to({ name: "preview" }) : to({ name: "sounds", soundIndex: s.soundIndex + 1 });
      }
      if (event.type === "skipAllSounds") return to({ name: "preview" });
      break;
    case "preview":
      if (event.type === "retake" && targetIndex(event.targetKey) >= 0) return to(poseScreen(state, targetIndex(event.targetKey), true));
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

/** Capture a pose, or first pick the archetype if it's the signature pose and there's none yet. */
function poseScreen(state: CaptureFlowState, poseIndex: number, retake: boolean): CaptureScreen {
  return poseIndex === SIGNATURE_TARGET_INDEX && !state.archetype ? { name: "archetype", retake } : { name: "pose", poseIndex, retake };
}

/** Where to go after a pose is captured. */
function nextAfter(state: CaptureFlowState, s: { poseIndex: number; retake: boolean }): CaptureScreen {
  if (s.retake) return { name: "review" };
  const next = s.poseIndex + 1;
  return next < CAPTURE_TARGET_COUNT ? poseScreen(state, next, false) : { name: "review" };
}
