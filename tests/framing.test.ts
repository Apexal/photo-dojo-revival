import { describe, expect, it } from "vitest";
import { LANDMARK, type NormalizedLandmark } from "../src/shared/fighter-model";
import { computeAnchor, estimateBodyScale } from "../src/shared/pose-geometry";
import { buildStickFigureLandmarks } from "../src/shared/stick-figure";
import {
  GhostFitter,
  STANDING_HEIGHT_RATIO,
  fitGhost,
  framingAdvice,
  ghostTransform,
  measurePerson,
} from "../src/capture/framing";

const W = 1280;
const H = 720;
const stick = buildStickFigureLandmarks("idle");
const stickScale = estimateBodyScale(stick);

/** The idle stick figure standing `heightFraction` of the frame tall, feet on the ground at (x, groundY). */
function person(heightFraction: number, x = W / 2, groundY = H * 0.95): NormalizedLandmark[] {
  const k = (heightFraction * H) / (STANDING_HEIGHT_RATIO * stickScale);
  const ground = computeAnchor(stick, "idle");
  return stick.map((l) => ({ ...l, x: x + (l.x - ground.x) * k, y: groundY + (l.y - ground.y) * k }));
}

describe("ghost fitting", () => {
  it("measures standing height from body proportions", () => {
    const m = measurePerson(person(0.6))!;
    expect(m.standingHeight / H).toBeCloseTo(0.6, 2);
    expect(m.groundY).toBeCloseTo(H * 0.95);
  });

  it("sizes and places the ghost on the person", () => {
    const fit = fitGhost(person(0.5, 400, 600), H)!;
    expect(fit.groundX).toBeCloseTo(400);
    expect(fit.groundY).toBeCloseTo(600);
    // Drawing the stick figure with the fit puts it exactly on the person.
    const t = ghostTransform(fit);
    const target = person(0.5, 400, 600);
    for (const i of [LANDMARK.nose, LANDMARK.leftHip, LANDMARK.rightAnkle]) {
      expect(stick[i].x * t.scale + t.translateX).toBeCloseTo(target[i].x, 0);
      expect(stick[i].y * t.scale + t.translateY).toBeCloseTo(target[i].y, 0);
    }
  });


  it("estimates the ground from the hips when the feet are out of view", () => {
    const p = person(0.6).map((l, i) => (i >= LANDMARK.leftKnee ? { ...l, visibility: 0.1 } : l));
    expect(measurePerson(p)!.groundY).toBeCloseTo(H * 0.95, -1);
  });

  it("no usable torso → no fit", () => {
    expect(fitGhost(person(0.6).map((l) => ({ ...l, visibility: 0 })), H)).toBeNull();
  });

  it("smooths toward the person and can hold the ground still", () => {
    const f = new GhostFitter(100);
    const a = f.update(person(0.6, 500), W, H, 0);
    expect(a.groundX).toBeCloseTo(500);
    const b = f.update(person(0.6, 700), W, H, 100);
    expect(b.groundX).toBeGreaterThan(550);
    expect(b.groundX).toBeLessThan(700);
    const c = f.update(person(0.6, 700, 400), W, H, 1000, { holdVertical: true });
    expect(c.groundY).toBeCloseTo(b.groundY);
    // Losing the person keeps the last fit.
    expect(f.update(null, W, H, 1100)).toEqual(c);
  });
});

describe("framing advice", () => {
  it("asks to come closer when small, step back when too big or cut off", () => {
    expect(framingAdvice(person(0.35), W, H)).toBe("closer");
    expect(framingAdvice(person(0.7), W, H)).toBe("ok");
    expect(framingAdvice(person(0.95), W, H)).toBe("further");
    expect(framingAdvice(person(0.7, W / 2, H * 1.1), W, H)).toBe("further"); // feet below the frame
    expect(framingAdvice(person(0.7, W / 2, H * 0.6), W, H)).toBe("further"); // head above it
    expect(framingAdvice(person(0.7, W / 2, H - 1), W, H)).toBe("further"); // feet on the bottom edge
  });

  it("asks to move toward the middle when some of them is at a side of the picture", () => {
    // Shifted so their nearest point is just inside a side: in the picture, but at its edge.
    const at = (edgeX: number, side: "left" | "right") => {
      const p = person(0.7);
      const xs = p.filter((l) => l.visibility >= 0.5).map((l) => l.x);
      const dx = side === "left" ? edgeX - Math.min(...xs) : edgeX - Math.max(...xs);
      return p.map((l) => ({ ...l, x: l.x + dx }));
    };
    expect(framingAdvice(at(5, "left"), W, H)).toBe("center");
    expect(framingAdvice(at(W - 5, "right"), W, H)).toBe("center");
    expect(framingAdvice(at(200, "left"), W, H)).toBe("ok");
    expect(framingAdvice(person(0.7, W / 2), W, H)).toBe("ok");
    // A lunge reaches further than standing: the same spot can be fine standing and too near the side lunging.
    const lungeX = 300;
    expect(framingAdvice(person(0.7, lungeX), W, H)).toBe("ok");
    const lunging = person(0.7, lungeX).map((l, i) => (i === LANDMARK.rightWrist || i === LANDMARK.rightIndex ? { ...l, x: 20 } : l));
    expect(framingAdvice(lunging, W, H)).toBe("center");
    // The hand's own points count, not just the wrist: fingers reach past it into the border.
    const handOut = person(0.7, W / 2).map((l, k) => (k === LANDMARK.leftPinky ? { ...l, x: W - 10 } : l));
    expect(framingAdvice(handOut, W, H)).toBe("center");
  });

});
