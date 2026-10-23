import { describe, expect, it } from "vitest";
import { FLOOR_BOUNCE, HIT_MARKER_FRAMES, HIT_MARKER_STYLES, REACTION_DELAY_FRAMES, fallPose, hitMarkerShape, hitShake, holdsStruckPose, markerColors } from "../src/game/render/hit-feel";
import { PLAYER_COLORS } from "../src/game/render/stage";
import { ATTACKS, KNOCKDOWN } from "../src/shared/frame-data";
import { FightSimulation } from "../src/simulation/fight-simulation";
import { HITSTOP_FRAMES, airFrames, createFighterState, type FighterState } from "../src/simulation/fighter-state-machine";
import { EMPTY_INPUT, type InputFrame } from "../src/simulation/input-frame";
import { stickFigureGeometry } from "../src/shared/stick-figure";

const idle = EMPTY_INPUT;
const press = (p: Partial<InputFrame>): InputFrame => ({ ...EMPTY_INPUT, ...p });

/** P1 punches a standing P2 at close range; returns every state from the punch on. */
function punchExchange() {
  const g = stickFigureGeometry();
  const sim = new FightSimulation([g, g], { seed: 1, practice: true, startPositions: [400, 880] });
  while (sim.current.round.phase !== "fighting") sim.step([idle, idle]);
  // Walk in close.
  for (let i = 0; i < 40; i++) sim.step([press({ right: true }), idle]);
  const states = [sim.step([press({ punch: true }), idle])];
  for (let i = 0; i < ATTACKS.punch.startup + HITSTOP_FRAMES + 4; i++) states.push(sim.step([idle, idle]));
  return states;
}

describe("hit weight", () => {
  it("holds the struck pose for the first frames of the freeze, then shows the reaction", () => {
    const states = punchExchange();
    const hitAt = states.findIndex((s) => s.events.some((e) => e.type === "hit"));
    expect(hitAt).toBeGreaterThan(0);
    const held = states.slice(hitAt).map((s) => holdsStruckPose(s.fighters[1]));
    expect(held.slice(0, REACTION_DELAY_FRAMES + 1)).toEqual([...Array(REACTION_DELAY_FRAMES).fill(true), false]);
    // The simulation itself already counts the hit on that frame (only the picture waits).
    expect(states[hitAt].fighters[1].action).toBe("hurt");
  });

  it("shakes the struck fighter during the freeze, harder on a hit than a block, and stops after", () => {
    const states = punchExchange();
    const hitAt = states.findIndex((s) => s.events.some((e) => e.type === "hit"));
    const defender = states[hitAt].fighters[1];
    expect(Math.abs(hitShake(defender, 10))).toBe(4);
    expect(hitShake(defender, 10)).toBe(-hitShake(defender, 11));
    expect(Math.abs(hitShake({ ...defender, action: "blockstun" }, 10))).toBe(2);
    expect(hitShake(states[hitAt + HITSTOP_FRAMES].fighters[1], 10)).toBe(0);
  });

  it("shakes the attacker too on a clean hit (less, out of step), but not on a block; it's only a picture", () => {
    const states = punchExchange();
    const hitAt = states.findIndex((s) => s.events.some((e) => e.type === "hit"));
    const [attacker, defender] = states[hitAt].fighters;
    expect(Math.abs(hitShake(attacker, 10, defender))).toBe(2);
    expect(Math.sign(hitShake(attacker, 10, defender))).toBe(-Math.sign(hitShake(defender, 10, attacker)));
    expect(hitShake(attacker, 10, { ...defender, action: "blockstun" })).toBe(0);
    expect(hitShake(states[hitAt + HITSTOP_FRAMES].fighters[0], 10, states[hitAt + HITSTOP_FRAMES].fighters[1])).toBe(0);
    // Positions are untouched: both stand exactly where they stood for the whole freeze.
    for (let f = 1; f <= HITSTOP_FRAMES; f++) {
      expect(states[hitAt + f].fighters.map((x) => x.position)).toEqual(states[hitAt].fighters.map((x) => x.position));
    }
  });

  it("markers: the attacker's colour, a symbol per kind, pop out, hold through hitstop, then fade", () => {
    expect(markerColors(0).rim).toBe(PLAYER_COLORS[0]);
    expect(markerColors(1).rim).toBe(PLAYER_COLORS[1]);
    expect(markerColors(0).core).toBe(0xf9ccc8); // P1's red, paled toward white for the hot centre
    const shapes = Object.values(HIT_MARKER_STYLES).map((s) => s.shape);
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(HIT_MARKER_STYLES.ko.radius).toBeGreaterThan(HIT_MARKER_STYLES.hit.radius);
    expect(HIT_MARKER_STYLES.block.radius).toBeLessThan(HIT_MARKER_STYLES.hit.radius);
    expect(hitMarkerShape(0)).toEqual({ scale: 0.55, alpha: 1 });
    expect(hitMarkerShape(HITSTOP_FRAMES)!.alpha).toBe(1);
    expect(hitMarkerShape(HIT_MARKER_FRAMES - 1)!.alpha).toBeLessThan(0.2);
    expect(hitMarkerShape(HIT_MARKER_FRAMES)).toBeNull();
    expect(hitMarkerShape(-1)).toBeNull(); // a replay rewound past it
  });
});

describe("knockdown drawing", () => {
  const at = (action: FighterState["action"], actionFrame: number) => ({ ...createFighterState(0, 1, 100), action, actionFrame });

  it("tips over through the flight, bounces on landing, lies flat, then rises", () => {
    expect(fallPose(at("idle", 0))).toBeNull();
    expect(fallPose(at("knockdown", 0))).toEqual({ tilt: 0, bounce: 0 });
    const flight = airFrames(KNOCKDOWN.launch.y);
    expect(fallPose(at("knockdown", flight / 2))!.tilt).toBeCloseTo(0.5, 1);
    expect(fallPose(at("knockdown", flight + 5))!.tilt).toBe(1);
    expect(fallPose(at("downed", 0))).toEqual({ tilt: 1, bounce: 0 });
    expect(fallPose(at("downed", FLOOR_BOUNCE.frames / 2))!.bounce).toBeCloseTo(FLOOR_BOUNCE.height);
    expect(fallPose(at("downed", 30))).toEqual({ tilt: 1, bounce: 0 });
    const rising = Array.from({ length: KNOCKDOWN.wakeFrames }, (_, f) => fallPose(at("wakeup", f))!.tilt);
    expect([...rising].sort((a, b) => b - a)).toEqual(rising);
    expect(rising.at(-1)).toBeCloseTo(0);
    expect(fallPose(at("ko", 200))!.tilt).toBe(1); // a KO stays down
  });

  it("holds the struck pose and shakes on an air hit that knocks down, like any hit", () => {
    const struck = { ...at("knockdown", 0), hitstopFrames: HITSTOP_FRAMES };
    expect(holdsStruckPose(struck)).toBe(true);
    expect(Math.abs(hitShake(struck, 3))).toBe(4);
  });
});
