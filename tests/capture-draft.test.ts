import { describe, expect, it } from "vitest";
import { CAPTURE_KEYS, SIGNATURE_TARGET_INDEX } from "../src/shared/pose-definitions";
import { DRAFT_VERSION, describeAge, isResumable, summarizeDraft, type CaptureDraft } from "../src/studio/capture-draft";

const draft = (keys: string[], savedAt = 1000): CaptureDraft => ({
  version: DRAFT_VERSION, savedAt, fighterId: "f", name: "", mode: "helped", archetype: null, sounds: {},
  captures: keys.map((key) => ({ key, cutPng: new Blob(), offsetX: 0, offsetY: 0, capturedAt: 0, geometry: { poseId: "idle", landmarks: [], frameWidth: 1, frameHeight: 1 } })),
});

describe("draft summary", () => {
  it("counts captured poses and finds the next missing one", () => {
    expect(summarizeDraft(draft(["idle", "walk", "block"]), 2000)).toEqual({ captured: 3, next: { poseIndex: 1, retake: false }, ageMs: 1000 });
    expect(summarizeDraft(draft(["idle", "idle-2"]))).toMatchObject({ next: { poseIndex: 2, retake: false } });
    const all = [...CAPTURE_KEYS];
    expect(summarizeDraft(draft(all))).toMatchObject({ captured: 16, next: null });
    expect(summarizeDraft(draft(all.filter((k) => k !== "signature")))).toMatchObject({ next: { poseIndex: SIGNATURE_TARGET_INDEX, retake: true } });
  });

  it("only offers recent v3 drafts with something in them", () => {
    expect(DRAFT_VERSION).toBe(3);
    expect(isResumable(draft(["idle"], 1000), 2000)).toBe(true);
    expect(isResumable(draft([], 1000), 2000)).toBe(false);
    expect(isResumable(draft(["idle"], 0), 10 * 24 * 3600 * 1000)).toBe(false);
    expect(isResumable(undefined)).toBe(false);
    // A phone's v2 draft (with its room code and "friend" mode) is silently not offered.
    expect(isResumable({ ...draft(["idle"], 1000), version: 2, mode: "friend", roomCode: "ABC234" }, 2000)).toBe(false);
    expect(isResumable({ version: 3, savedAt: 1000 }, 2000)).toBe(false);
  });

  it("describes a draft's age", () => {
    expect(describeAge(10_000)).toBe("just now");
    expect(describeAge(5 * 60_000)).toBe("5 min ago");
    expect(describeAge(3 * 3600_000)).toBe("3 h ago");
    expect(describeAge(2 * 24 * 3600_000)).toBe("2 d ago");
  });
});
