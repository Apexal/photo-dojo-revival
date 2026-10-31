import { describe, expect, it } from "vitest";
import { ARCHETYPE_IDS } from "../src/shared/archetypes";
import { captureTargetsFor } from "../src/shared/pose-definitions";
import { STICK_POSES, buildStickFigureLandmarks } from "../src/shared/stick-figure";
import { defaultEdit, stickFromLandmarks, editKey, ghostSelfCheck, isModified, parseEdits, specSnippet, stickSnippet, toDefinition } from "../src/lab/pose-edits";

describe("lab pose edits", () => {
  it("an untouched edit is the definition the studio uses, ghost and all", () => {
    for (const archetype of ARCHETYPE_IDS) {
      for (const target of captureTargetsFor(archetype)) {
        const edit = defaultEdit(target.key, archetype);
        expect(toDefinition(edit, target.key)).toEqual(target.definition);
        expect(isModified(edit, target.key, archetype)).toBe(false);
      }
    }
  });

  it("notices a change, and doesn't share state between edits", () => {
    const edit = defaultEdit("punch", "brawler");
    edit.angleTargets[0].degrees += 5;
    expect(isModified(edit, "punch", "brawler")).toBe(true);
    expect(isModified(defaultEdit("punch", "brawler"), "punch", "brawler")).toBe(false);
  });

  it("keys the signature by archetype", () => {
    expect(editKey("signature", "acrobat")).toBe("signature:acrobat");
    expect(editKey("kick-2", "acrobat")).toBe("kick-2");
  });

  it("writes snippets in the source's shape", () => {
    expect(specSnippet(defaultEdit("idle", "brawler"), "idle", "brawler")).toBe([
      "  idle: {",
      '    label: "Fighting stance",',
      '    voicePrompt: "Fighting stance. Fists up by your chin, feet apart.",',
      "    angleTargets: [",
      '      { joint: "rightElbow", degrees: 45, tolerance: 35 },',
      '      { joint: "leftElbow", degrees: 45, tolerance: 35 },',
      '      { joint: "rightShoulderElevation", degrees: 30, tolerance: 25 },',
      '      { joint: "legSpread", degrees: 22, tolerance: 12 },',
      "    ],",
      "    requiredVisibleLandmarks: FULL_BODY,",
      "  },",
    ].join("\n"));
    const alternate = specSnippet(defaultEdit("punch-2", "brawler"), "punch-2", "brawler");
    expect(alternate).toContain('  "punch-2": {\n    poseId: "punch",');
    expect(alternate).toContain('requiredVisibleLandmarks: ["rightWrist", "rightShoulder", "leftHip", "rightAnkle"]');
    expect(alternate).toContain('attackLimb: "arm"');
    expect(specSnippet(defaultEdit("signature", "guardian"), "signature", "guardian")).toMatch(/^ {2}guardian: \{/);
    expect(stickSnippet(defaultEdit("idle", "brawler"), "idle", "brawler")).toBe([
      "  idle: {",
      "    torsoLean: 5, headTilt: 5,",
      "    arms: { right: { swing: 30, bend: 45 }, left: { swing: 20, bend: 40 } },",
      "    legs: { right: { swing: 14, bend: 165 }, left: { swing: -12, bend: 165 } },",
      "  },",
    ].join("\n"));
  });

  it("every shipped ghost strikes its own pose", () => {
    for (const archetype of ARCHETYPE_IDS) {
      for (const { key } of captureTargetsFor(archetype)) {
        expect(ghostSelfCheck(defaultEdit(key, archetype), key).score, `${archetype} ${key}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("checks the ghost against its own definition", () => {
    const edit = defaultEdit("punch", "brawler");
    expect(ghostSelfCheck(edit, "punch").score).toBeLessThanOrEqual(1);
    edit.stick.arms.right.bend = 60; // a bent arm isn't a punch
    expect(ghostSelfCheck(edit, "punch").score).toBeGreaterThan(1);
  });

  it("reads a ghost back off a pose", () => {
    for (const poseId of ["idle", "punch", "kick", "crouch", "hurt"] as const) {
      const params = STICK_POSES[poseId];
      const read = stickFromLandmarks(buildStickFigureLandmarks(poseId, params));
      expect(read.torsoLean, poseId).toBeCloseTo(params.torsoLean, -1);
      for (const part of ["arms", "legs"] as const) {
        for (const s of ["left", "right"] as const) {
          expect(Math.abs(read[part][s].swing - params[part][s].swing), `${poseId} ${part} ${s} swing`).toBeLessThanOrEqual(1);
          expect(Math.abs(read[part][s].bend - params[part][s].bend), `${poseId} ${part} ${s} bend`).toBeLessThanOrEqual(1);
        }
      }
      expect(Math.abs(read.headTilt - params.headTilt), `${poseId} head`).toBeLessThanOrEqual(1);
    }
  });

  it("reads a left-facing pose as facing right, and swaps limbs for a left-side match", () => {
    const punch = buildStickFigureLandmarks("punch");
    const mirrored = punch.map((l) => ({ ...l, x: 512 - l.x }));
    expect(stickFromLandmarks(mirrored)).toEqual(stickFromLandmarks(punch));
    const swapped = stickFromLandmarks(punch, "left");
    expect(swapped.arms.right).toEqual(stickFromLandmarks(punch).arms.left);
  });

  it("drops saved edits that don't parse", () => {
    const good = defaultEdit("kick", "brawler");
    expect(parseEdits(JSON.stringify({ kick: good, bad: { label: "x" } }))).toEqual({ kick: good });
    expect(parseEdits("{nope")).toEqual({});
    expect(parseEdits(null)).toEqual({});
  });
});
