import { describe, expect, it } from "vitest";
import { ATTACKS, attackPhaseAt, attackTotalFrames, groundAnchorFor, poseAtFrame, poseForAction } from "../src/shared/frame-data";
import { GROUND_LINE_Y, JUMP_ANCHOR_Y } from "../src/shared/fighter-model";
import { midHip } from "../src/shared/pose-geometry";
import { stickFigureGeometry } from "../src/shared/stick-figure";

describe("frame data", () => {
  it("punch: 4 startup, 3 active, 10 recovery", () => {
    const p = ATTACKS.punch;
    expect(attackTotalFrames(p)).toBe(17);
    expect(p.sequence.reduce((s, e) => s + e.frames, 0)).toBe(17);
    expect([0, 3, 4, 6, 7, 16, 17].map((f) => attackPhaseAt(p, f))).toEqual(["startup", "startup", "active", "active", "recovery", "recovery", null]);
  });

  it("kick: 7 startup, 4 active, 16 recovery", () => {
    const k = ATTACKS.kick;
    expect(attackTotalFrames(k)).toBe(27);
    expect(k.sequence.reduce((s, e) => s + e.frames, 0)).toBe(27);
    expect(attackPhaseAt(k, 6)).toBe("startup");
    expect(attackPhaseAt(k, 7)).toBe("active");
    expect(attackPhaseAt(k, 11)).toBe("recovery");
  });

  it("sequence phases agree with the frame counts", () => {
    for (const attack of Object.values(ATTACKS)) {
      for (let f = 0; f < attackTotalFrames(attack); f++) expect(poseAtFrame(attack.sequence, f).phase).toBe(attackPhaseAt(attack, f));
    }
  });

  it("maps actions to poses as hard cuts", () => {
    expect(poseForAction("punch", 3)).toBe("idle");
    expect(poseForAction("punch", 4)).toBe("punch");
    expect(poseForAction("punch", 11)).toBe("idle");
    expect(poseForAction("walk", 0)).toBe("walk");
    expect(poseForAction("walk", 10)).toBe("idle");
    expect(poseForAction("walk", 20)).toBe("walk");
    expect(poseForAction("ko", 0)).toBe("hurt");
    expect(poseForAction("block", 0)).toBe("block");
  });

  it("jump's ground anchor sits one idle pelvis height below its pelvis anchor", () => {
    const geo = stickFigureGeometry();
    expect(groundAnchorFor(geo, "idle")).toEqual({ x: 256, y: GROUND_LINE_Y });
    const jump = groundAnchorFor(geo, "jump");
    expect(jump.x).toBe(256);
    const pelvisHeight = GROUND_LINE_Y - midHip(geo.idle.landmarks).y;
    expect(pelvisHeight).toBeGreaterThan(100);
    expect(jump.y).toBeCloseTo(JUMP_ANCHOR_Y + pelvisHeight);
  });
});
