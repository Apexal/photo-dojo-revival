import { describe, expect, it } from "vitest";
import { CAPTURE_TARGETS } from "../src/shared/pose-definitions";
import { captureFlowReducer, initialCaptureFlow, targetAt, type CaptureEvent, type CaptureFlowState } from "../src/capture/capture-flow";

const run = (state: CaptureFlowState, ...events: CaptureEvent[]) => events.reduce(captureFlowReducer, state);
const indexOf = (key: string) => CAPTURE_TARGETS.findIndex((t) => t.key === key);
const capture: CaptureEvent[] = [{ type: "poseCaptured" }, { type: "graceElapsed" }];

function toReview(roomCode: string | null = "ABC234") {
  let s = run(initialCaptureFlow(roomCode), { type: "selectMode", mode: "solo" }, { type: "start" }, { type: "modelsReady" });
  for (let i = 0; i < CAPTURE_TARGETS.length; i++) {
    expect(s.screen).toEqual({ name: "pose", poseIndex: i, retake: false });
    s = run(s, ...capture);
  }
  return s;
}

describe("capture flow", () => {
  it("walks intro → tips → all 13 poses → review", () => {
    const s = toReview();
    expect(s.mode).toBe("solo");
    expect(s.screen).toEqual({ name: "review" });
    expect(targetAt(0).poseId).toBe("idle");
    expect(targetAt(indexOf("punch") + 1).key).toBe("punch-2"); // uppercut right after punch
    expect(targetAt(indexOf("block") + 1).key).toBe("crouch"); // crouch block right after block
    expect(targetAt(CAPTURE_TARGETS.length - 1).key).toBe("win-2");
  });

  it("both modes go straight to the first pose once the models are ready", () => {
    const solo = run(initialCaptureFlow(null), { type: "selectMode", mode: "solo" }, { type: "start" }, { type: "modelsReady" });
    expect(solo.screen).toEqual({ name: "pose", poseIndex: 0, retake: false });
    const friend = run(initialCaptureFlow(null), { type: "selectMode", mode: "friend" }, { type: "start" }, { type: "modelsReady" });
    expect(friend.screen).toEqual({ name: "pose", poseIndex: 0, retake: false });
  });

  it("a resumed solo draft continues at the next pose", () => {
    const s = run(initialCaptureFlow(null), { type: "resume", mode: "solo", roomCode: null, nextPoseIndex: 5 }, { type: "start" }, { type: "modelsReady" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: 5, retake: false });
  });

  it("shows the captured screen between poses", () => {
    const s = run(initialCaptureFlow(null), { type: "selectMode", mode: "friend" }, { type: "start" }, { type: "modelsReady" }, { type: "poseCaptured" });
    expect(s.screen).toEqual({ name: "captured", poseIndex: 0, retake: false, rough: false });
  });

  it("a failed capture goes back to the same pose", () => {
    const s = run(initialCaptureFlow(null), { type: "selectMode", mode: "friend" }, { type: "start" }, { type: "modelsReady" }, ...capture, { type: "poseCaptured" }, { type: "captureFailed" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: 1, retake: false });
  });

  it("a rough cut-out waits for retake or keep instead of moving on", () => {
    const start = run(initialCaptureFlow(null), { type: "selectMode", mode: "friend" }, { type: "start" }, { type: "modelsReady" }, ...capture);
    const rough = run(start, { type: "poseCaptured" }, { type: "captureRough" });
    expect(rough.screen).toEqual({ name: "captured", poseIndex: 1, retake: false, rough: true });
    expect(run(rough, { type: "graceElapsed" })).toBe(rough);
    expect(run(rough, { type: "retakeRough" }).screen).toEqual({ name: "pose", poseIndex: 1, retake: false });
    expect(run(rough, { type: "keepRough" }).screen).toEqual({ name: "pose", poseIndex: 2, retake: false });
    // Only a rough capture can be kept or retaken this way.
    const fine = run(start, { type: "poseCaptured" });
    expect(run(fine, { type: "keepRough" })).toBe(fine);
  });

  it("keeping a rough retake from review returns to review", () => {
    const s = run(toReview(), { type: "retake", targetKey: "kick" }, { type: "poseCaptured" }, { type: "captureRough" }, { type: "keepRough" });
    expect(s.screen).toEqual({ name: "review" });
  });

  it("retakes a pose from the review strip and returns to review", () => {
    let s = run(toReview(), { type: "retake", targetKey: "kick" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: indexOf("kick"), retake: true });
    s = run(s, ...capture);
    expect(s.screen).toEqual({ name: "review" });
  });

  it("a second-version pose can be retaken from review", () => {
    const s = run(toReview(), { type: "retake", targetKey: "win-2" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: indexOf("win-2"), retake: true });
    expect(run(s, ...capture).screen).toEqual({ name: "review" });
  });

  it("records three sounds, each skippable, then previews", () => {
    let s = run(toReview(), { type: "reviewDone" });
    expect(s.screen).toEqual({ name: "sounds", soundIndex: 0 });
    s = run(s, { type: "soundDone" }, { type: "skipSound" });
    expect(s.screen).toEqual({ name: "sounds", soundIndex: 2 });
    s = run(s, { type: "soundDone" });
    expect(s.screen).toEqual({ name: "preview" });
    expect(run(toReview(), { type: "reviewDone" }, { type: "skipAllSounds" }).screen).toEqual({ name: "preview" });
  });

  it("sends when a room code is present, saves otherwise", () => {
    const finish = (room: string | null) => run(toReview(room), { type: "reviewDone" }, { type: "skipAllSounds" }, { type: "finish" });
    expect(finish("ABC234").screen).toEqual({ name: "sending" });
    expect(finish(null).screen).toEqual({ name: "saved" });
  });

  it("send failure offers retry or falls back to saved", () => {
    let s = run(toReview(), { type: "reviewDone" }, { type: "skipAllSounds" }, { type: "finish" }, { type: "sendFailed", reason: "timeout" });
    expect(s.screen).toEqual({ name: "sendFailed", reason: "timeout" });
    expect(run(s, { type: "retrySend" }).screen).toEqual({ name: "sending" });
    s = run(s, { type: "retrySend" }, { type: "sent" });
    expect(s.screen).toEqual({ name: "sent" });
  });

  it("ignores events that don't apply to the current screen", () => {
    const s = initialCaptureFlow(null);
    expect(run(s, { type: "poseCaptured" }, { type: "finish" })).toBe(s);
  });

  it("errors and restarts", () => {
    const s = run(toReview(), { type: "fail", message: "camera denied" });
    expect(s.screen).toEqual({ name: "error", message: "camera denied" });
    expect(run(s, { type: "restart" })).toEqual(initialCaptureFlow("ABC234"));
  });
});

import { isResumable, summarizeDraft, type CaptureDraft } from "../src/capture/capture-draft";

describe("resuming a saved capture", () => {
  it("continues from the first missing pose after the camera loads", () => {
    let s = run(initialCaptureFlow("ABC234"), { type: "resume", mode: "solo", roomCode: null, nextPoseIndex: 3 });
    expect(s.screen).toEqual({ name: "tips" });
    expect(s.mode).toBe("solo");
    s = run(s, { type: "start" }, { type: "modelsReady" });
    expect(s.screen).toEqual({ name: "pose", poseIndex: 3, retake: false });
    s = run(s, ...capture);
    expect(s.screen).toEqual({ name: "pose", poseIndex: 4, retake: false });
  });

  it("goes straight to review when all main poses are in", () => {
    const s = run(initialCaptureFlow(null), { type: "resume", mode: "friend", roomCode: "XYZ789", nextPoseIndex: null });
    expect(s.screen).toEqual({ name: "review" });
    expect(s.roomCode).toBe("XYZ789"); // the draft's room, since the URL had none
  });

  it("a room code in the URL wins over the draft's", () => {
    const s = run(initialCaptureFlow("NEW234"), { type: "resume", mode: "friend", roomCode: "OLD234", nextPoseIndex: null });
    expect(s.roomCode).toBe("NEW234");
  });
});

describe("draft summary", () => {
  const draft = (keys: string[], savedAt = 1000): CaptureDraft => ({
    version: 1, savedAt, fighterId: "f", name: "", mode: "friend", roomCode: null, sounds: {},
    captures: keys.map((key) => ({ key, cutPng: new Blob(), offsetX: 0, offsetY: 0, capturedAt: 0, geometry: { poseId: "idle", landmarks: [], frameWidth: 1, frameHeight: 1 } })),
  });

  it("counts captured poses and finds the next missing one", () => {
    expect(summarizeDraft(draft(["idle", "walk", "block"]), 2000)).toEqual({ captured: 3, complete: false, nextPoseIndex: 3, ageMs: 1000 });
    const all = ["idle", "walk", "block", "crouch", "punch", "punch-2", "kick", "kick-2", "jump", "hurt", "hurt-2", "win", "win-2"];
    expect(summarizeDraft(draft(all))).toMatchObject({ captured: 13, complete: true, nextPoseIndex: null });
    expect(summarizeDraft(draft(all.filter((k) => k !== "kick-2")))).toMatchObject({ complete: false, nextPoseIndex: indexOf("kick-2") });
  });

  it("only offers recent drafts with something in them", () => {
    expect(isResumable(draft(["idle"], 1000), 2000)).toBe(true);
    expect(isResumable(draft([], 1000), 2000)).toBe(false);
    expect(isResumable(draft(["idle"], 0), 10 * 24 * 3600 * 1000)).toBe(false);
    expect(isResumable(undefined)).toBe(false);
  });
});
