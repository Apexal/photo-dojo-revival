import { describe, expect, it } from "vitest";
import { CAPTURE_TARGET_COUNT, SIGNATURE_DEFINITIONS, SIGNATURE_TARGET_INDEX, captureTargetsFor } from "../src/shared/pose-definitions";
import { GRACE_MS, canRetake, initialStudioFlow, studioFlowReducer, targetAt, type StudioEvent, type StudioFlowState } from "../src/studio/studio-flow";

const run = (state: StudioFlowState, ...events: StudioEvent[]) => events.reduce(studioFlowReducer, state);
const indexOf = (key: string) => captureTargetsFor("brawler").findIndex((t) => t.key === key);
const capture: StudioEvent[] = [{ type: "poseCaptured" }, { type: "graceElapsed" }];
const ready: StudioEvent = { type: "cameraReady" };
const lost: StudioEvent = { type: "cameraLost" };
const guardian: StudioEvent = { type: "pickArchetype", archetype: "guardian" };

function toReview() {
  let s = run(initialStudioFlow(), ready, { type: "selectMode", mode: "helped" }, { type: "setupDone" }, guardian, { type: "start" }, { type: "modelsReady" });
  // Every pose in a row: the style was picked at the start.
  for (let i = 0; i < CAPTURE_TARGET_COUNT; i++) {
    expect(s.screen).toEqual({ name: "pose", poseIndex: i, retake: false });
    s = run(s, ...capture);
  }
  return s;
}

describe("studio flow", () => {
  it("starts on setup, on my own by default, and only goes on once the camera is ready", () => {
    const s = initialStudioFlow();
    expect(s).toMatchObject({ screen: { name: "setup" }, mode: "solo", cameraReady: false });
    expect(GRACE_MS.solo).toBeGreaterThan(GRACE_MS.helped);
    expect(run(s, { type: "setupDone" })).toBe(s);
    expect(run(s, ready, { type: "setupDone" }).screen).toEqual({ name: "archetype", retake: false });
    // A camera that drops on the setup screen just disables "start" again.
    expect(run(s, ready, lost, { type: "setupDone" }).screen).toEqual({ name: "setup" });
  });

  it("picks the style first, then the tips", () => {
    const s = run(initialStudioFlow(), ready, { type: "setupDone" }, { type: "pickArchetype", archetype: "acrobat" });
    expect(s).toMatchObject({ archetype: "acrobat", screen: { name: "tips" } });
    // The camera dropping while picking comes back to the picker.
    const dropped = run(initialStudioFlow(), ready, { type: "setupDone" }, lost);
    expect(dropped.screen).toEqual({ name: "cameraLost", back: { name: "archetype", retake: false } });
    expect(run(dropped, ready).screen).toEqual({ name: "archetype", retake: false });
  });

  it("walks setup → archetype → tips → loading → all 16 poses → review → sounds → preview → saved", () => {
    let s = toReview();
    expect(s.mode).toBe("helped");
    expect(s.screen).toEqual({ name: "review" });
    expect(s.archetype).toBe("guardian");
    s = run(s, { type: "reviewDone" });
    expect(s.screen).toEqual({ name: "sounds", soundIndex: 0 });
    s = run(s, { type: "soundDone" }, { type: "skipSound" }, { type: "soundDone" });
    expect(s.screen).toEqual({ name: "preview" });
    s = run(s, { type: "finish" });
    expect(s.screen).toEqual({ name: "saving" });
    expect(run(s, { type: "saveFailed" }).screen).toEqual({ name: "preview" });
    s = run(s, { type: "saved" });
    expect(s.screen).toEqual({ name: "saved" });
    // Build another: a fresh fighter, the same camera and mode.
    expect(run(s, { type: "restart" })).toEqual({ ...initialStudioFlow(true, "helped") });
  });

  it("knows the targets", () => {
    expect(targetAt(0, null).poseId).toBe("idle");
    expect(targetAt(indexOf("punch") + 1, null).key).toBe("punch-2");
    expect(targetAt(SIGNATURE_TARGET_INDEX, "guardian").definition).toBe(SIGNATURE_DEFINITIONS.guardian);
    expect(() => targetAt(SIGNATURE_TARGET_INDEX, null)).toThrow();
  });

  it("rough captures: retake or keep", () => {
    const s = run(initialStudioFlow(), ready, { type: "setupDone" }, guardian, { type: "start" }, { type: "modelsReady" }, { type: "poseCaptured" }, { type: "captureRough" });
    expect(s.screen).toEqual({ name: "captured", poseIndex: 0, retake: false, rough: true });
    expect(run(s, { type: "graceElapsed" })).toBe(s); // a rough one waits for the answer
    expect(run(s, { type: "retakeRough" }).screen).toEqual({ name: "pose", poseIndex: 0, retake: false });
    expect(run(s, { type: "keepRough" }).screen).toEqual({ name: "pose", poseIndex: 1, retake: false });
    expect(run(s, { type: "captureFailed" }).screen).toEqual({ name: "pose", poseIndex: 0, retake: false });
  });

  it("a lost camera mid-pose pauses on cameraLost, and comes back to the same pose with its retake flag", () => {
    let s = run(initialStudioFlow(), ready, { type: "setupDone" }, guardian, { type: "start" }, { type: "modelsReady" }, ...capture, ...capture, { type: "poseCaptured" });
    expect(s.screen).toEqual({ name: "captured", poseIndex: 2, retake: false, rough: false });
    s = run(s, lost);
    expect(s.screen).toEqual({ name: "cameraLost", back: { name: "pose", poseIndex: 2, retake: false } });
    expect(s.cameraReady).toBe(false);
    // The capture that was in flight finishing doesn't move on.
    expect(run(s, { type: "graceElapsed" })).toBe(s);
    expect(run(s, ready).screen).toEqual({ name: "pose", poseIndex: 2, retake: false });

    const retaking = run(toReview(), { type: "retake", targetKey: "kick" }, lost);
    expect(retaking.screen).toEqual({ name: "cameraLost", back: { name: "pose", poseIndex: indexOf("kick"), retake: true } });
    const back = run(retaking, ready, ...capture);
    expect(back.screen).toEqual({ name: "review" });
  });

  it("a lost camera while picking the style comes back to the picker", () => {
    let s = run(toReview(), { type: "changeArchetype" }, lost);
    expect(s.screen).toEqual({ name: "cameraLost", back: { name: "archetype", retake: true } });
    s = run(s, ready);
    expect(s.screen).toEqual({ name: "archetype", retake: true });
  });

  it("losing the camera on the review just marks it; a retake then asks for a camera first", () => {
    let s = run(toReview(), lost);
    expect(s.screen).toEqual({ name: "review" });
    s = run(s, { type: "retake", targetKey: "punch-2" });
    expect(s.screen).toEqual({ name: "camera", next: { poseIndex: indexOf("punch-2"), retake: true } });
    expect(run(s, { type: "cancelCamera" }).screen).toEqual({ name: "review" });
    s = run(s, ready);
    expect(s.screen).toEqual({ name: "pose", poseIndex: indexOf("punch-2"), retake: true });
    expect(run(s, ...capture).screen).toEqual({ name: "review" });

    // From the preview too.
    const preview = run(toReview(), { type: "reviewDone" }, { type: "skipAllSounds" }, lost, { type: "retake", targetKey: "idle" });
    expect(preview.screen).toEqual({ name: "camera", next: { poseIndex: 0, retake: true } });
  });

  it("a new style without a camera: picks it, then asks for the camera for the signature pose", () => {
    let s = run(toReview(), lost, { type: "changeArchetype" });
    expect(s.screen).toEqual({ name: "archetype", retake: true });
    s = run(s, { type: "pickArchetype", archetype: "acrobat" });
    expect(s.archetype).toBe("acrobat");
    expect(s.screen).toEqual({ name: "camera", next: { poseIndex: SIGNATURE_TARGET_INDEX, retake: true }, previousArchetype: "guardian" });
    expect(run(s, ready).screen).toEqual({ name: "pose", poseIndex: SIGNATURE_TARGET_INDEX, retake: true });
  });

  it("backing out of the camera screen after a change of style keeps the old style (an edit opens without a camera)", () => {
    const edit = run(initialStudioFlow(), { type: "startEdit", archetype: "acrobat", hasSources: true });
    let s = run(edit, { type: "changeArchetype" }, { type: "pickArchetype", archetype: "brawler" });
    expect(s).toMatchObject({ archetype: "brawler", screen: { name: "camera", previousArchetype: "acrobat" } });
    s = run(s, { type: "cancelCamera" });
    expect(s).toMatchObject({ screen: { name: "review" }, archetype: "acrobat" });
    // So picking the original style again backs out as usual.
    expect(run(s, { type: "changeArchetype" }, { type: "pickArchetype", archetype: "acrobat" }).screen).toEqual({ name: "review" });
  });

  it("re-picking the current style from the review backs out without a retake", () => {
    const s = run(toReview(), { type: "changeArchetype" }, { type: "pickArchetype", archetype: "guardian" });
    expect(s.screen).toEqual({ name: "review" });
  });

  it("models ready but the camera gone meanwhile: the camera screen, then the first pose", () => {
    const s = run(initialStudioFlow(), ready, { type: "setupDone" }, guardian, { type: "start" }, lost, { type: "modelsReady" });
    expect(s.screen).toEqual({ name: "camera", next: { poseIndex: 0, retake: false } });
    expect(run(s, ready).screen).toEqual({ name: "pose", poseIndex: 0, retake: false });
    // Not a retake: there's no review to go back to.
    expect(run(s, { type: "cancelCamera" })).toBe(s);
  });

  it("resumes a draft: from the first missing pose after loading, or straight to the review", () => {
    let s = run(initialStudioFlow(), { type: "resume", mode: "helped", archetype: "brawler", next: { poseIndex: 3, retake: false } });
    expect(s).toMatchObject({ screen: { name: "tips" }, mode: "helped" });
    s = run(s, ready, { type: "start" }, { type: "modelsReady" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: 3, retake: false });
    expect(run(s, ...capture).screen).toEqual({ name: "pose", poseIndex: 4, retake: false });

    const done = run(initialStudioFlow(), { type: "resume", mode: "solo", archetype: "grappler", next: null });
    expect(done).toMatchObject({ screen: { name: "review" }, archetype: "grappler", cameraReady: false });

    // Resumed without a camera: loading ends on the camera screen at the resume point.
    // A draft from before the style came first: pick it, then carry on where it stopped.
    const old = run(initialStudioFlow(), { type: "resume", mode: "solo", archetype: null, next: { poseIndex: 3, retake: false } });
    expect(old.screen).toEqual({ name: "archetype", retake: false });
    expect(run(old, guardian, ready, { type: "start" }, { type: "modelsReady" })).toMatchObject({ archetype: "guardian", screen: { name: "pose", poseIndex: 3 } });

    const noCam = run(initialStudioFlow(), { type: "resume", mode: "solo", archetype: "brawler", next: { poseIndex: 5, retake: false } }, { type: "start" }, { type: "modelsReady" });
    expect(noCam.screen).toEqual({ name: "camera", next: { poseIndex: 5, retake: false } });
  });

  it("edits a fighter with sources: straight to its review, retakes and a new style as usual, saved over itself", () => {
    let s = run(initialStudioFlow(), { type: "startEdit", archetype: "acrobat", hasSources: true });
    expect(s).toMatchObject({ screen: { name: "review" }, archetype: "acrobat", edit: { hasSources: true }, cameraReady: false });
    expect(canRetake(s)).toBe(true);
    // No camera yet: a retake picks one first, then comes back to the review.
    s = run(s, { type: "retake", targetKey: "kick-2" });
    expect(s.screen).toEqual({ name: "camera", next: { poseIndex: indexOf("kick-2"), retake: true } });
    s = run(s, ready, ...capture);
    expect(s.screen).toEqual({ name: "review" });
    expect(run(s, { type: "changeArchetype" }).screen).toEqual({ name: "archetype", retake: true });
    expect(run(s, { type: "recaptureAll" })).toBe(s); // it has its cut-outs: nothing to recapture wholesale
    s = run(s, { type: "reviewDone" }, { type: "skipAllSounds" }, { type: "finish" }, { type: "saved" });
    expect(s.screen).toEqual({ name: "saved" });
    // Build another: a new fighter, not an edit.
    expect(run(s, { type: "restart" }).edit).toBeUndefined();
  });

  it("edits a fighter without sources: no single retakes or new style; rename, sounds, or every pose again", () => {
    const s = run(initialStudioFlow(true), { type: "startEdit", archetype: "grappler", hasSources: false });
    expect(s.screen).toEqual({ name: "review" });
    expect(canRetake(s)).toBe(false);
    expect(run(s, { type: "retake", targetKey: "idle" })).toBe(s);
    expect(run(s, { type: "changeArchetype" })).toBe(s);
    const preview = run(s, { type: "reviewDone" }, { type: "soundDone" }, { type: "skipSound" }, { type: "skipSound" });
    expect(preview.screen).toEqual({ name: "preview" });
    expect(run(preview, { type: "retake", targetKey: "idle" })).toBe(preview);
    expect(run(preview, { type: "finish" }, { type: "saved" }).screen).toEqual({ name: "saved" });

    // Capture all poses again: the whole sequence (keeping the style, so no picker), then the review with retakes on.
    let again = run(s, { type: "recaptureAll" });
    expect(again).toMatchObject({ screen: { name: "tips" }, edit: { hasSources: true } });
    again = run(again, { type: "start" }, { type: "modelsReady" });
    for (let i = 0; i < CAPTURE_TARGET_COUNT; i++) {
      expect(again.screen).toEqual({ name: "pose", poseIndex: i, retake: false });
      again = run(again, ...capture);
    }
    expect(again.screen).toEqual({ name: "review" });
    expect(again.archetype).toBe("grappler");
    expect(run(again, { type: "retake", targetKey: "idle" }).screen).toEqual({ name: "pose", poseIndex: 0, retake: true });
  });

  it("only starts an edit from the setup screen", () => {
    const review = toReview();
    expect(run(review, { type: "startEdit", archetype: "brawler", hasSources: true })).toBe(review);
    expect(run(review, { type: "recaptureAll" })).toBe(review); // not editing
    expect(canRetake(review)).toBe(true);
  });

  it("ignores events that don't apply, and errors", () => {
    const s = initialStudioFlow();
    expect(run(s, { type: "poseCaptured" }, { type: "finish" }, { type: "cancelCamera" })).toBe(s);
    expect(run(s, lost)).toBe(s);
    const err = run(toReview(), { type: "fail", message: "boom" });
    expect(err.screen).toEqual({ name: "error", message: "boom" });
    expect(run(err, { type: "restart" }).screen).toEqual({ name: "setup" });
  });
});
