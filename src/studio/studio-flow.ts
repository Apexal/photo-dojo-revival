import type { ArchetypeId } from "../shared/archetypes";
import { SOUND_IDS, type SoundId } from "../shared/fighter-model";
import { CAPTURE_KEYS, CAPTURE_TARGET_COUNT, SIGNATURE_TARGET_INDEX, captureTargetsFor, type CaptureTarget } from "../shared/pose-definitions";
import type { CaptureMode, ResumePoint } from "./capture-draft";

/** Pause after each capture before the next pose; on your own it gives time to get back in place. */
export const GRACE_MS: Record<CaptureMode, number> = { helped: 1200, solo: 3000 };

/** A pose to come back to after the camera is back. */
type PoseAt = { poseIndex: number; retake: boolean };

export type StudioScreen =
  /** Mode, camera, the resume-draft card; "start" once the camera is ready. */
  | { name: "setup" }
  | { name: "tips" }
  | { name: "loading" }
  | { name: "pose"; poseIndex: number; retake: boolean }
  /** `rough`: the cut-out failed the quality check and waits for "retake" or "keep". */
  | { name: "captured"; poseIndex: number; retake: boolean; rough: boolean }
  /**
   * Pick the archetype: first thing after setup, so the poses then run in one go
   * (`retake`: changing it from the review, which retakes the signature pose).
   */
  | { name: "archetype"; retake: boolean }
  /** The camera went away mid-capture: back to `back` once it's ready again. */
  | { name: "cameraLost"; back: { name: "pose"; poseIndex: number; retake: boolean } | { name: "archetype"; retake: boolean } }
  /**
   * A pose needs taking but no camera is ready (a retake after the phone left,
   * or in an edit): pick one, then the pose. `previousArchetype`: the style
   * was just changed for this signature retake; backing out restores it.
   */
  | { name: "camera"; next: PoseAt; previousArchetype?: ArchetypeId }
  | { name: "review" }
  | { name: "sounds"; soundIndex: number }
  | { name: "preview" }
  | { name: "saving" }
  | { name: "saved" }
  | { name: "error"; message: string };

export type StudioEvent =
  | { type: "selectMode"; mode: CaptureMode }
  /** Setup done (needs a ready camera). */
  | { type: "setupDone" }
  | { type: "start" }
  | { type: "modelsReady" }
  | { type: "cameraReady" }
  | { type: "cameraLost" }
  /** Back out of the camera screen to the review (the retake isn't happening, nor a change of style; retakes only). */
  | { type: "cancelCamera" }
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
  | { type: "saved" }
  /** Saving failed: back to the preview (the app says why). */
  | { type: "saveFailed" }
  | { type: "fail"; message: string }
  /** "Build another" / "Start over": a new fighter, same camera and mode. */
  | { type: "restart" }
  /** Pick up a saved draft: straight to review if all poses are in, else continue from the first missing one. */
  | { type: "resume"; mode: CaptureMode; archetype: ArchetypeId | null; next: ResumePoint | null }
  /** Edit a saved fighter (studio/edit-session.ts): straight to its review. */
  | { type: "startEdit"; archetype: ArchetypeId; hasSources: boolean }
  /** Editing a fighter without sources: take all sixteen poses again (they replace the old ones). */
  | { type: "recaptureAll" };

export interface StudioFlowState {
  screen: StudioScreen;
  mode: CaptureMode;
  /** The camera source is up (local camera running, or a phone streaming). */
  cameraReady: boolean;
  /** Where the pose sequence continues after loading (resumed drafts). */
  resumeAt?: ResumePoint | null;
  /** Picked right after setup (or from a resumed draft); null until then. */
  archetype: ArchetypeId | null;
  /**
   * Editing a saved fighter. Without its sources (`hasSources: false`) single
   * retakes and a change of style are off: only renaming, the sounds, or
   * capturing every pose again.
   */
  edit?: { hasSources: boolean };
}

/** "On my own" is the default: with a big screen, nobody has to hold anything. */
export function initialStudioFlow(cameraReady = false, mode: CaptureMode = "solo"): StudioFlowState {
  return { screen: { name: "setup" }, mode, cameraReady, archetype: null };
}

/** The capture target at an index (all sixteen poses, in capture order); the signature pose needs the archetype. */
export function targetAt(index: number, archetype: ArchetypeId | null): CaptureTarget {
  if (index === SIGNATURE_TARGET_INDEX && !archetype) throw new Error("No archetype picked for the signature pose");
  return captureTargetsFor(archetype ?? "brawler")[index]; // only the signature target differs between archetypes
}
const targetIndex = (key: string) => (CAPTURE_KEYS as readonly string[]).indexOf(key);

/** Screens that show the live camera (they share one DOM; only the HUD changes between them). */
export const isLiveScreen = (s: StudioScreen): s is Extract<StudioScreen, { name: "pose" | "captured" }> =>
  s.name === "pose" || s.name === "captured";

/** Single poses can be retaken (and the style changed): always, except when editing a fighter without sources. */
export const canRetake = (state: Pick<StudioFlowState, "edit">): boolean => !state.edit || state.edit.hasSources;

export const soundIdAt = (index: number): SoundId => SOUND_IDS[index];

/**
 * setup → archetype → tips → loading → pose 1..16, without a break (each:
 * pose → captured, or back to pose if it came out rough) → review → sounds 1..3 → preview → saving → saved. A lost camera on a live
 * screen pauses on `cameraLost` until it's back; a retake without a camera
 * goes through the `camera` screen. Editing a saved fighter starts on the
 * review (`startEdit`). Pure; unknown events for the current screen leave the
 * state unchanged.
 */
export function studioFlowReducer(state: StudioFlowState, event: StudioEvent): StudioFlowState {
  const s = state.screen;
  const to = (screen: StudioScreen): StudioFlowState => ({ ...state, screen });

  if (event.type === "fail") return to({ name: "error", message: event.message });
  if (event.type === "restart") return initialStudioFlow(state.cameraReady, state.mode);
  if (event.type === "cameraLost") {
    if (!state.cameraReady) return state;
    const lost = { ...state, cameraReady: false };
    if (s.name === "archetype") return { ...lost, screen: { name: "cameraLost", back: { name: "archetype", retake: s.retake } } };
    if (isLiveScreen(s)) return { ...lost, screen: { name: "cameraLost", back: { name: "pose", poseIndex: s.poseIndex, retake: s.retake } } };
    return lost;
  }
  if (event.type === "cameraReady") {
    if (state.cameraReady) return state;
    const ready = { ...state, cameraReady: true };
    if (s.name === "cameraLost") return { ...ready, screen: s.back };
    if (s.name === "camera") return { ...ready, screen: { name: "pose", ...s.next } };
    return ready;
  }

  switch (s.name) {
    case "setup":
      if (event.type === "selectMode") return { ...state, mode: event.mode };
      if (event.type === "setupDone" && state.cameraReady) return to(state.archetype ? { name: "tips" } : { name: "archetype", retake: false });
      if (event.type === "resume") {
        const resumed = { ...state, mode: event.mode, archetype: event.archetype };
        if (event.next === null) return { ...resumed, screen: { name: "review" } };
        // A draft from before the style was picked first: pick it now, then carry on.
        return { ...resumed, resumeAt: event.next, screen: event.archetype ? { name: "tips" } : { name: "archetype", retake: false } };
      }
      if (event.type === "startEdit") return { ...state, archetype: event.archetype, edit: { hasSources: event.hasSources }, screen: { name: "review" } };
      break;
    case "tips":
      if (event.type === "start") return to({ name: "loading" });
      break;
    case "loading":
      if (event.type === "modelsReady") {
        const at = state.resumeAt ?? { poseIndex: 0, retake: false };
        return { ...state, resumeAt: null, screen: poseOrCamera(state, at) };
      }
      break;
    case "pose":
      if (event.type === "poseCaptured") return to({ ...s, name: "captured", rough: false });
      break;
    case "captured": {
      const again: StudioScreen = { name: "pose", poseIndex: s.poseIndex, retake: s.retake };
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
      // Picking the style it already has, from the review, is how to back out of changing it.
      if (event.type === "pickArchetype" && s.retake && event.archetype === state.archetype) return to({ name: "review" });
      // At the start: on to the tips, then every pose in a row.
      if (event.type === "pickArchetype" && !s.retake) return { ...state, archetype: event.archetype, screen: { name: "tips" } };
      if (event.type === "pickArchetype") {
        const picked = { ...state, archetype: event.archetype };
        const screen = poseOrCamera(picked, { poseIndex: SIGNATURE_TARGET_INDEX, retake: s.retake });
        // Changed from the review with no camera yet: the old style stays on hand in case the retake is called off.
        const previous = s.retake && state.archetype && screen.name === "camera" ? { previousArchetype: state.archetype } : {};
        return { ...picked, screen: { ...screen, ...previous } };
      }
      break;
    case "camera":
      // Only a retake can back out to the review: a pose still to take for the first time has no review yet.
      if (event.type === "cancelCamera" && s.next.retake) return { ...state, archetype: s.previousArchetype ?? state.archetype, screen: { name: "review" } };
      break;
    case "review":
      if (event.type === "retake" && canRetake(state) && targetIndex(event.targetKey) >= 0) return to(poseOrCamera(state, { poseIndex: targetIndex(event.targetKey), retake: true }));
      if (event.type === "changeArchetype" && canRetake(state)) return to({ name: "archetype", retake: true });
      // All sixteen again, in order, keeping the style; afterwards the new cut-outs allow single retakes.
      if (event.type === "recaptureAll" && state.edit && !state.edit.hasSources) {
        return { ...state, edit: { hasSources: true }, resumeAt: null, screen: { name: "tips" } };
      }
      if (event.type === "reviewDone") return to({ name: "sounds", soundIndex: 0 });
      break;
    case "sounds":
      if (event.type === "soundDone" || event.type === "skipSound") {
        return s.soundIndex + 1 >= SOUND_IDS.length ? to({ name: "preview" }) : to({ name: "sounds", soundIndex: s.soundIndex + 1 });
      }
      if (event.type === "skipAllSounds") return to({ name: "preview" });
      break;
    case "preview":
      if (event.type === "retake" && canRetake(state) && targetIndex(event.targetKey) >= 0) return to(poseOrCamera(state, { poseIndex: targetIndex(event.targetKey), retake: true }));
      if (event.type === "finish") return to({ name: "saving" });
      break;
    case "saving":
      if (event.type === "saved") return to({ name: "saved" });
      if (event.type === "saveFailed") return to({ name: "preview" });
      break;
    default:
      break;
  }
  return state;
}

/** The pose, or the camera screen first when no camera is ready. The archetype is always picked by now. */
function poseOrCamera(state: StudioFlowState, at: PoseAt): StudioScreen {
  return state.cameraReady ? { name: "pose", ...at } : { name: "camera", next: at };
}

/** Where to go after a pose is captured. */
function nextAfter(state: StudioFlowState, s: PoseAt): StudioScreen {
  if (s.retake) return { name: "review" };
  const next = s.poseIndex + 1;
  return next < CAPTURE_TARGET_COUNT ? poseOrCamera(state, { poseIndex: next, retake: false }) : { name: "review" };
}
