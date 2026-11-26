import { describe, expect, it } from "vitest";
import { addMatch, emptyRecord, parseRecord } from "../src/game/fighter-records";
import { haloOutline, hornTriangles } from "../src/game/render/reputation-mark";
import { addManners, adornmentOf, MANNERS_DECAY, REPUTATION_TIERS, reputationOf, tierOf, type Manners } from "../src/game/reputation";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation } from "../src/simulation/fight-simulation";
import { input } from "../src/simulation/input-frame";
import { MatchStatsTracker } from "../src/simulation/match-stats";
import { ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const idle = input();
const geo = stickFigureGeometry();
const of = (good: number, bad: number) => reputationOf({ manners: { good, bad } });
const match = (handshakes: number, snubs: number, gloats = 0) => ({ handshakes, snubs, gloats });
const career = (matches: ReturnType<typeof match>[], from: Manners = { good: 0, bad: 0 }) => matches.reduce(addManners, from);

describe("reputationOf", () => {
  it("gives a newcomer a clean slate on the polite side", () => {
    const r = reputationOf(null);
    expect(r.known).toBe(false);
    expect(r.score).toBeGreaterThan(0.5);
    expect(reputationOf(emptyRecord())).toEqual(r);
  });

  it("doesn't brand a fighter rude over one snub", () => {
    expect(of(1, 1).label).not.toBe("Rude");
    expect(of(1, 1).score).toBeLessThan(of(2, 0).score);
  });

  it("runs from Rude (a habit of refusing) to Respectful (taking every one)", () => {
    expect(of(0, 15).label).toBe("Rude");
    expect(of(15, 0).label).toBe("Respectful");
    const tiers = [15, 10, 5, 0].map((bad) => of(15 - bad, bad).tier);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
  });

  it("maps scores onto every tier", () => {
    expect(tierOf(0)).toBe(0);
    expect(tierOf(1)).toBe(REPUTATION_TIERS.length - 1);
  });

  it("wears horns at the bottom, a halo at the top, nothing between or on a clean slate", () => {
    expect(adornmentOf(of(0, 15))).toBe("horns");
    expect(adornmentOf(of(15, 0))).toBe("halo");
    expect(adornmentOf(of(5, 3))).toBeNull();
    expect(adornmentOf(reputationOf(null))).toBeNull();
  });
});

describe("manners", () => {
  it("counts handshakes taken for, snubs and gloats against", () => {
    expect(addManners({ good: 0, bad: 0 }, match(3, 1, 2))).toEqual({ good: 2, bad: 3 });
  });

  it("fades older matches, so a habitual snubber can win their name back", () => {
    const rude = career(Array(8).fill(match(3, 3)));
    expect(reputationOf({ manners: rude }).label).toBe("Rude");
    const reformed = career(Array(8).fill(match(3, 0)), rude);
    expect(reputationOf({ manners: reformed }).tier).toBeGreaterThanOrEqual(3);
    expect(addManners({ good: 10, bad: 10 }, match(0, 0))).toEqual({ good: 10 * MANNERS_DECAY, bad: 10 * MANNERS_DECAY });
  });

  it("starts a record saved before manners were kept from its career counts", () => {
    expect(parseRecord({ handshakes: 6, snubs: 2, gloats: 1 }).manners).toEqual({ good: 4, bad: 3 });
    expect(parseRecord({ snubs: 3 }).manners).toEqual({ good: 0, bad: 3 });
    expect(parseRecord({ snubs: 3, manners: { good: 1.5, bad: 0.5 } }).manners).toEqual({ good: 1.5, bad: 0.5 });
  });
});

describe("on the record", () => {
  it("counts an intro played through as a handshake on offer for both, and adds it to the career", () => {
    const sim = new FightSimulation([geo, geo]);
    const stats = new MatchStatsTracker();
    for (let i = 0; i <= ROUND_INTRO_FRAMES; i++) stats.record(sim.step([idle, input({ right: true })]));
    const [p0, p1] = stats.result.players;
    expect([p0.handshakes, p1.handshakes]).toEqual([1, 1]);
    expect(p1.snubs).toBe(1);
    const record = addMatch(emptyRecord(), p1, 1, "draw");
    expect([record.handshakes, record.snubs]).toEqual([1, 1]);
    expect(record.manners).toEqual({ good: 0, bad: 1 });
  });

  it("counts a taunt over a floored opponent as a gloat, and one over a standing one not", () => {
    const sim = new FightSimulation([geo, geo]);
    const stats = new MatchStatsTracker();
    for (let i = 0; i <= ROUND_INTRO_FRAMES; i++) stats.record(sim.step([idle, idle]));
    const now = sim.current;
    const taunt = { ...now, events: [{ type: "taunt" as const, player: 0 as const }] };
    stats.record(taunt);
    stats.record({ ...taunt, fighters: [now.fighters[0], { ...now.fighters[1], action: "downed" }] });
    const p0 = stats.result.players[0];
    expect([p0.taunts, p0.gloats]).toEqual([2, 1]);
  });
});

describe("halo and horns", () => {
  const head = geo.idle.landmarks;
  const noseY = head[0].y;

  it("float the halo and grow the horns above the face", () => {
    const ring = haloOutline(head)!;
    expect(ring.length).toBeGreaterThan(8);
    expect(Math.max(...ring.map((p) => p.y))).toBeLessThan(noseY);
    const horns = hornTriangles(head)!;
    expect(horns).toHaveLength(2);
    for (const [, , tip] of horns) expect(tip.y).toBeLessThan(noseY);
  });

  it("lifts the halo as it bobs", () => {
    const low = haloOutline(head, 0)!, high = haloOutline(head, 1)!;
    expect(high[0].y).toBeLessThan(low[0].y);
  });
});
