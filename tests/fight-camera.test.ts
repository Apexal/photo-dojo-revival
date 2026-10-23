import { describe, expect, it } from "vitest";
import { CAMERA, FightCamera, cameraTarget, clampView } from "../src/game/render/fight-camera";
import { GAME_HEIGHT, GAME_WIDTH, worldToScreen } from "../src/game/render/stage";

const feet = (x1: number, x2: number, y1 = 0, y2 = 0) => [worldToScreen({ x: x1, y: y1 }), worldToScreen({ x: x2, y: y2 })];
/** The world rectangle a view shows. */
const shown = (v: { zoom: number; centerX: number; centerY: number }) => ({
  left: v.centerX - GAME_WIDTH / (2 * v.zoom), right: v.centerX + GAME_WIDTH / (2 * v.zoom),
  top: v.centerY - GAME_HEIGHT / (2 * v.zoom), bottom: v.centerY + GAME_HEIGHT / (2 * v.zoom),
});

describe("fight camera", () => {
  it("shows the whole stage when the fighters are far apart, and closes in as they near", () => {
    expect(cameraTarget(feet(200, 1080)).zoom).toBe(1);
    const mid = cameraTarget(feet(450, 850)).zoom, close = cameraTarget(feet(560, 720)).zoom;
    expect(mid).toBeGreaterThan(1);
    expect(close).toBeGreaterThan(mid);
    expect(close).toBeLessThanOrEqual(CAMERA.maxZoom);
  });

  it("centres between the fighters but never shows past the stage, and keeps the floor in view", () => {
    const v = cameraTarget(feet(560, 720));
    expect(v.centerX).toBeCloseTo(640);
    expect(shown(v).bottom).toBeCloseTo(GAME_HEIGHT);
    const cornered = shown(cameraTarget(feet(40, 200)));
    expect(cornered.left).toBeCloseTo(0);
    expect(cornered.right).toBeLessThanOrEqual(GAME_WIDTH);
  });

  it("keeps both fighters whole: room beside them, and zooms out for a jump", () => {
    for (const [a, b] of [[300, 700], [560, 720], [100, 600]]) {
      const s = shown(cameraTarget(feet(a, b)));
      expect(s.left).toBeLessThanOrEqual(Math.max(0, a - CAMERA.sideMargin) + 1e-6);
      expect(s.right).toBeGreaterThanOrEqual(Math.min(GAME_WIDTH, b + CAMERA.sideMargin) - 1e-6);
    }
    const standing = cameraTarget(feet(560, 720)), jumping = cameraTarget(feet(560, 720, -220));
    expect(jumping.zoom).toBeLessThan(standing.zoom);
    // As far up as the head goes, or the stage's top if the jump goes higher than that.
    expect(shown(jumping).top).toBeLessThanOrEqual(Math.max(0, worldToScreen({ x: 0, y: -220 }).y - CAMERA.fighterHeight) + 1e-6);
    const hop = cameraTarget(feet(560, 720, -80));
    expect(shown(hop).top).toBeLessThanOrEqual(worldToScreen({ x: 0, y: -80 }).y - CAMERA.fighterHeight + 1e-6);
  });

  it("eases toward the framing, punches in on impact, and settles back", () => {
    const cam = new FightCamera();
    cam.snap(feet(200, 1080));
    const first = cam.update(feet(560, 720), 1).zoom;
    expect(first).toBeGreaterThan(1);
    expect(first).toBeLessThan(cameraTarget(feet(560, 720)).zoom); // not there in one frame
    for (let i = 0; i < 120; i++) cam.update(feet(560, 720), 1);
    const settled = cam.view.zoom;
    expect(settled).toBeCloseTo(cameraTarget(feet(560, 720)).zoom, 3);
    cam.kick("ko");
    expect(cam.update(feet(560, 720), 1).zoom).toBeGreaterThan(settled + 0.05);
    for (let i = 0; i < 40; i++) cam.update(feet(560, 720), 1);
    expect(cam.update(feet(560, 720), 1).zoom).toBeCloseTo(settled, 3);
  });

  it("clamps any view to the stage", () => {
    expect(clampView({ zoom: 0.5, centerX: -100, centerY: 9999 })).toEqual({ zoom: 1, centerX: 640, centerY: 360 });
  });
});
