import { describe, expect, it } from "vitest";
import { ReplayBuffer } from "../src/game/replay-buffer";

describe("KO replay buffer", () => {
  it("keeps only the lead window before the finish", () => {
    const b = new ReplayBuffer<number>(5, 3);
    for (let i = 0; i < 20; i++) b.push(i);
    expect(b.clip()).toEqual([15, 16, 17, 18, 19]);
  });

  it("records a tail after the finish, then freezes", () => {
    const b = new ReplayBuffer<number>(5, 3);
    for (let i = 0; i < 10; i++) b.push(i);
    b.markFinish(); // the blow landed on frame 9
    for (let i = 10; i < 30; i++) b.push(i);
    expect(b.clip()).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(b.frozen).toBe(true);
  });

  it("marking twice keeps the first finish, and reset starts over", () => {
    const b = new ReplayBuffer<number>(3, 1);
    b.push(1);
    b.markFinish();
    b.push(2);
    b.markFinish();
    expect(b.clip()).toEqual([1, 2]);
    b.reset();
    expect(b.hasFinish).toBe(false);
    expect(b.clip()).toEqual([]);
  });

  it("works with a real fight: the KO blow is in the clip", async () => {
    const { FightSimulation } = await import("../src/simulation/fight-simulation");
    const { stickFigureGeometry } = await import("../src/shared/stick-figure");
    const { input } = await import("../src/simulation/input-frame");
    const geo = stickFigureGeometry();
    const sim = new FightSimulation([geo, geo], { startPositions: [565, 715] });
    const b = new ReplayBuffer<ReturnType<typeof sim.step>>();
    for (let i = 0; i < 3000 && sim.current.round.phase !== "roundOver"; i++) {
      const s = sim.step([input({ punch: i % 20 === 0, right: true }), input()]);
      b.push(s);
      if (s.events.some((e) => e.type === "ko")) b.markFinish();
    }
    const clip = b.clip();
    expect(clip.some((s) => s.events.some((e) => e.type === "ko"))).toBe(true);
    expect(clip.length).toBeLessThanOrEqual(150 + 45);
    expect(clip.at(-1)!.fighters[1].action).toBe("ko");
  });
});
