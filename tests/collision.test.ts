import { describe, expect, it } from "vitest";
import { LANDMARK, LANDMARK_COUNT, type NormalizedLandmark } from "../src/shared/fighter-model";
import {
  HURT_PART_SIZE,
  KICK_HITBOX_SIZE,
  PUNCH_HITBOX_SIZE,
  bodyBoxFor,
  canonicalReach,
  hitboxFor,
  hitboxReach,
  hurtboxesFor,
  rawHitboxFor,
  rawHurtboxesFor,
  type PoseGeometry,
} from "../src/shared/frame-data";
import { boxesOverlap, hitConnects, horizontalOverlap, toWorldBox, type Placement } from "../src/simulation/collision";
import { stickFigureGeometry } from "../src/shared/stick-figure";

const anchor = { x: 256, y: 480 };

/** A synthetic upright figure: all landmarks on a vertical line, wrist and ankle placed explicitly. */
function figure(overrides: Partial<Record<keyof typeof LANDMARK, [number, number, number?]>> = {}): PoseGeometry {
  const landmarks: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
    x: 256,
    y: 480 - (i / (LANDMARK_COUNT - 1)) * 300,
    visibility: 0.9,
  }));
  for (const [name, [x, y, v]] of Object.entries(overrides)) {
    landmarks[LANDMARK[name as keyof typeof LANDMARK]] = { x, y, visibility: v ?? 0.9 };
  }
  return { landmarks, anchorPoint: anchor };
}

const at = (x: number, facing: 1 | -1): Placement => ({ position: { x, y: 0 }, facing, anchor });
const covers = (boxes: { x: number; y: number; width: number; height: number }[], p: { x: number; y: number }) =>
  boxes.some((b) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height);
const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

describe("box derivation", () => {
  it("hurtboxes cover the head, torso and limbs, but not the empty space around them", () => {
    const punch = stickFigureGeometry().punch;
    const l = punch.landmarks;
    const boxes = hurtboxesFor(punch);
    const hip = mid(l[LANDMARK.leftHip], l[LANDMARK.rightHip]);
    expect(covers(boxes, mid(l[LANDMARK.leftShoulder], l[LANDMARK.rightShoulder]))).toBe(true);
    expect(covers(boxes, mid(l[LANDMARK.leftEar], l[LANDMARK.nose]))).toBe(true);
    expect(covers(boxes, mid(l[LANDMARK.rightElbow], l[LANDMARK.rightWrist]))).toBe(true); // the extended arm can be hit
    expect(covers(boxes, mid(l[LANDMARK.rightKnee], l[LANDMARK.rightAnkle]))).toBe(true);
    // Under the extended fist, at hip height: open air, not body.
    expect(covers(boxes, { x: l[LANDMARK.rightWrist].x, y: hip.y })).toBe(false);
  });

  it("limbs with low visibility get no hurtbox", () => {
    const pose = figure({ rightElbow: [330, 300], rightWrist: [400, 300], leftElbow: [180, 300, 0.2], leftWrist: [100, 300, 0.2] });
    const boxes = hurtboxesFor(pose);
    expect(covers(boxes, { x: 400, y: 300 })).toBe(true);
    expect(covers(boxes, { x: 100, y: 300 })).toBe(false);
  });

  it("punch hitbox spans the whole arm: 48 px squares on wrist, elbow and shoulder, attacking side", () => {
    const pose = figure({
      rightShoulder: [300, 300], rightElbow: [340, 300], rightWrist: [400, 300],
      leftShoulder: [290, 290], leftElbow: [330, 290], leftWrist: [380, 290],
    });
    expect(rawHitboxFor("punch", pose)).toEqual({ x: 300 - 24, y: 300 - 24, width: 100 + PUNCH_HITBOX_SIZE, height: PUNCH_HITBOX_SIZE });
    expect(rawHitboxFor("punch", { ...pose, attackSide: "left" })).toEqual({ x: 290 - 24, y: 290 - 24, width: 90 + 48, height: 48 });
  });

  it("kick hitbox spans the shin: 56 px squares on ankle and knee", () => {
    const pose = figure({ rightKnee: [380, 340], rightAnkle: [450, 360] });
    expect(rawHitboxFor("kick", pose)).toEqual({ x: 380 - 28, y: 340 - 28, width: 70 + KICK_HITBOX_SIZE, height: 20 + KICK_HITBOX_SIZE });
  });

  it("body box is shoulders-to-ankles narrowed to 60% width", () => {
    const pose = figure({
      leftShoulder: [206, 250], rightShoulder: [306, 250],
      leftHip: [216, 360], rightHip: [296, 360],
      leftAnkle: [156, 480], rightAnkle: [356, 480],
    });
    const box = bodyBoxFor(pose);
    expect(box.width).toBeCloseTo(120); // 60% of 200
    expect(box.x).toBeCloseTo(196);
    expect(box.y).toBe(250);
    expect(box.height).toBe(230);
  });

  it("body box is never narrower than 0.7 torso lengths (side view)", () => {
    const pose = figure({
      leftShoulder: [250, 250], rightShoulder: [262, 250],
      leftHip: [250, 360], rightHip: [262, 360],
      leftAnkle: [246, 480], rightAnkle: [266, 480],
    });
    const box = bodyBoxFor(pose);
    expect(box.width).toBeCloseTo(0.7 * 110);
    expect(box.x + box.width / 2).toBeCloseTo(256);
  });
});

describe("reach fairness", () => {
  const reference = canonicalReach("punch");

  it("long arms are pulled in to the reference reach +15%", () => {
    const longArms = figure({ rightElbow: [256 + 0.8 * reference, 300], rightWrist: [256 + 1.6 * reference, 300] });
    const raw = rawHitboxFor("punch", longArms);
    const fair = hitboxFor("punch", longArms);
    expect(hitboxReach(raw, longArms)).toBeGreaterThan(reference * 1.5);
    expect(hitboxReach(fair, longArms)).toBeCloseTo(reference * 1.15);
    expect(fair.width).toBe(raw.width);
    expect(fair.y).toBe(raw.y);
  });

  it("short reach is pushed out to the reference −15%", () => {
    const short = figure({ rightElbow: [270, 300], rightWrist: [290, 300] });
    expect(hitboxReach(hitboxFor("punch", short), short)).toBeCloseTo(reference * 0.85);
  });

  it("reach within ±15% is left alone", () => {
    const close = figure({ rightElbow: [256 + 0.4 * reference, 300], rightWrist: [256 + reference - 24, 300] });
    expect(hitboxFor("punch", close)).toEqual(rawHitboxFor("punch", close));
  });

  it("each move has its own reference: an uppercut reaches less far forward than a punch", () => {
    expect(canonicalReach("uppercut")).toBeLessThan(canonicalReach("punch"));
  });
});

describe("hurtbox fairness", () => {
  const extent = (boxes: { x: number; width: number }[]) =>
    Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x));

  it("hurtboxes are clipped to the reference fighter's extent for the same frame", () => {
    const ref = stickFigureGeometry().idle;
    // A sprawling capture: arms far out in front and behind.
    const wide = { ...ref, landmarks: ref.landmarks.map((l, i) => (i === LANDMARK.rightWrist ? { ...l, x: l.x + 200 } : i === LANDMARK.leftWrist ? { ...l, x: l.x - 200 } : l)) };
    expect(extent(rawHurtboxesFor(wide))).toBeGreaterThan(extent(rawHurtboxesFor(ref)) + 200);
    expect(extent(hurtboxesFor(wide, { poseId: "idle", variant: 0 }))).toBeLessThan(extent(rawHurtboxesFor(ref)) * 1.4);
    // The reference itself is unchanged.
    expect(hurtboxesFor(ref, { poseId: "idle", variant: 0 })).toEqual(rawHurtboxesFor(ref));
  });

  it("body parts are the same thickness for everyone: a narrow capture still has a full-width torso", () => {
    const ref = stickFigureGeometry().idle;
    const narrow = { ...ref, landmarks: ref.landmarks.map((l) => ({ ...l, x: ref.anchorPoint.x + (l.x - ref.anchorPoint.x) * 0.3 })) };
    const torso = hurtboxesFor(narrow, { poseId: "idle", variant: 0 })[1];
    expect(torso.width).toBeGreaterThanOrEqual(2 * HURT_PART_SIZE.torso);
  });
});

describe("world transform and overlap", () => {
  it("translates by position relative to the anchor when facing right", () => {
    expect(toWorldBox({ x: 300, y: 400, width: 20, height: 10 }, at(1000, 1))).toEqual({ x: 1044, y: -80, width: 20, height: 10 });
  });

  it("mirrors around the anchor when facing left", () => {
    expect(toWorldBox({ x: 300, y: 400, width: 20, height: 10 }, at(1000, -1))).toEqual({ x: 1000 - 64, y: -80, width: 20, height: 10 });
  });

  it("overlap is strict: touching edges don't overlap", () => {
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(boxesOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 10, height: 10 })).toBe(true);
    expect(horizontalOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 6, y: 5, width: 10, height: 10 })).toBe(4);
    expect(horizontalOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 6, y: 50, width: 10, height: 10 })).toBe(0);
  });

  it("a right-facing punch reaches an opponent in front, not behind", () => {
    const attacker = figure({ rightElbow: [340, 300], rightWrist: [400, 300] });
    const hit = hitboxFor("punch", attacker, null);
    const defender = figure();
    const hurt = hurtboxesFor(defender);
    expect(hitConnects(hit, at(500, 1), hurt, at(640, -1))).toBe(true);
    expect(hitConnects(hit, at(500, 1), hurt, at(360, 1))).toBe(false);
  });

  it("facing flips mirror the hitbox so a left-facing punch reaches leftward", () => {
    const hit = hitboxFor("punch", figure({ rightElbow: [340, 300], rightWrist: [400, 300] }), null);
    const hurt = hurtboxesFor(figure());
    expect(hitConnects(hit, at(640, -1), hurt, at(500, 1))).toBe(true);
    expect(hitConnects(hit, at(640, -1), hurt, at(780, -1))).toBe(false);
  });

  it("range is limited by the reach of the landmark", () => {
    const hit = hitboxFor("punch", figure({ rightElbow: [340, 300], rightWrist: [400, 300] }), null);
    const hurt = hurtboxesFor(figure());
    // reach = (400 - 256) + 24 = 168; the defender's torso box starts HURT_PART_SIZE.torso before its anchor
    const edge = 168 + HURT_PART_SIZE.torso;
    expect(hitConnects(hit, at(0, 1), hurt, at(edge - 0.5, -1))).toBe(true);
    expect(hitConnects(hit, at(0, 1), hurt, at(edge + 0.5, -1))).toBe(false);
  });

  it("point-blank hits connect: the fist can be past the opponent and the forearm still hits", () => {
    const hit = hitboxFor("punch", figure({ rightElbow: [300, 300], rightWrist: [400, 300] }), null);
    const hurt = hurtboxesFor(figure()); // a thin upright body: torso 256 ± HURT_PART_SIZE.torso
    // Defender's body sits between the attacker's elbow and fist (fist is 30 px past it).
    expect(hitConnects(hit, at(0, 1), hurt, at(110, -1))).toBe(true);
  });

  it("vertical separation prevents a hit", () => {
    const hit = hitboxFor("punch", figure({ rightElbow: [340, 300], rightWrist: [400, 300] }), null);
    const hurt = hurtboxesFor(figure());
    expect(hitConnects(hit, at(500, 1), hurt, { ...at(640, -1), position: { x: 640, y: -400 } })).toBe(false);
  });
});
