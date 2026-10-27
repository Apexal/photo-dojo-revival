import { describe, expect, it } from "vitest";
import { PoseTweener, type FrameRef, type TweenSource } from "../src/game/render/pose-tweener";
import { LANDMARK } from "../src/shared/fighter-model";
import { groundAnchorFor, type FighterGeometry } from "../src/shared/frame-data";
import { REACH_FRAMES, SECOND_HAND_FRAMES, SHAKE_PERIOD_FRAMES, SHAKE_PX, SHAKE_START_FRAME, SHAKES, handOf, handshakeGrips, shakeAt, shakenGrip, turnArm } from "../src/shared/handshake";
import { buildStickFigureLandmarks, stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, handshakeShakeOf, introStep, snubDueFrame, type FightEvent, type FightState } from "../src/simulation/fight-simulation";
import { input } from "../src/simulation/input-frame";
import { INTRO, ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const geo = stickFigureGeometry();
const idle = input();

/** A fighter who holds their hand out higher (and with the left hand). */
function tallHandshake(): FighterGeometry {
  const pose = geo.handshake;
  const lifted = turnArm(pose.landmarks, "right", -0.35);
  // Relabel the arms, as for a left-handed capture.
  const swapped = lifted.map((l) => ({ ...l }));
  for (const joint of ["Shoulder", "Elbow", "Wrist", "Pinky", "Index", "Thumb"] as const) {
    swapped[LANDMARK[`left${joint}`]] = lifted[LANDMARK[`right${joint}`]];
    swapped[LANDMARK[`right${joint}`]] = lifted[LANDMARK[`left${joint}`]];
  }
  return { ...geo, handshake: { ...pose, landmarks: swapped, attackSide: "left" } };
}

/** Where a fighter's handshake hand is in the world (aimed grip, placed at their position). */
function worldHand(sim: FightSimulation, geometry: FighterGeometry, player: 0 | 1) {
  const f = sim.current.fighters[player];
  const grip = sim.grips[player];
  const hand = handOf(grip.landmarks, grip.side);
  const anchor = groundAnchorFor(geometry, "handshake");
  return { x: f.position.x + f.facing * (hand.x - anchor.x), y: f.position.y + hand.y - anchor.y };
}

describe("handshake grips", () => {
  it("aims both hands at one height without changing arm length", () => {
    const geometries: [FighterGeometry, FighterGeometry] = [geo, tallHandshake()];
    const grips = handshakeGrips(geometries);
    const heights = grips.map((g, i) => handOf(g.landmarks, g.side).y - groundAnchorFor(geometries[i], "handshake").y);
    expect(heights[0]).toBeCloseTo(heights[1], 6);
    const before = handOf(geometries[1].handshake.landmarks, "left");
    const shoulder = geometries[1].handshake.landmarks[LANDMARK.leftShoulder];
    const after = handOf(grips[1].landmarks, "left");
    expect(Math.hypot(after.x - shoulder.x, after.y - shoulder.y)).toBeCloseTo(Math.hypot(before.x - shoulder.x, before.y - shoulder.y), 6);
    expect(grips[1].side).toBe("left");
    expect(grips.every((g) => g.reach > 0)).toBe(true);
  });

  it("leaves matching hands alone", () => {
    const [grip] = handshakeGrips([geo, geo]);
    expect(grip.landmarks[LANDMARK.rightWrist].x).toBeCloseTo(geo.handshake.landmarks[LANDMARK.rightWrist].x, 6);
  });

  it("pumps the hand up and down by SHAKE_PX, starting and ending where the hands meet", () => {
    const [grip] = handshakeGrips([geo, geo]);
    const rest = handOf(grip.landmarks, "right");
    const [down, up] = [handOf(shakenGrip(grip, 1), "right"), handOf(shakenGrip(grip, -1), "right")];
    expect(Math.hypot(down.x - rest.x, down.y - rest.y)).toBeCloseTo(SHAKE_PX, 0);
    expect(Math.hypot(up.x - rest.x, up.y - rest.y)).toBeCloseTo(SHAKE_PX, 0);
    expect(down.y).toBeGreaterThan(rest.y + SHAKE_PX / 2);
    expect(up.y).toBeLessThan(rest.y - SHAKE_PX / 2);
    expect(shakeAt(0)).toBe(0.5);
    expect(shakeAt(-5)).toBe(0.5); // waiting for the other hand
    expect(shakeAt(SHAKES * SHAKE_PERIOD_FRAMES)).toBe(0.5);
    expect(shakeAt(SHAKES * SHAKE_PERIOD_FRAMES + 3)).toBe(0.5); // holding on before letting go
  });
});

describe("round intro", () => {
  it("walks in, shakes hands with the hands overlapping, and walks back to the start", () => {
    const geometries: [FighterGeometry, FighterGeometry] = [geo, tallHandshake()];
    const sim = new FightSimulation(geometries);
    const start = sim.current.fighters.map((f) => f.position.x);
    const seen: [string[], string[]] = [[], []];
    const offered: number[] = [];
    let closest = Infinity;
    for (let i = 0; i < ROUND_INTRO_FRAMES - 1; i++) {
      const state = sim.step([input({ punch: true, right: true }), input({ kick: true, left: true })]); // only holding back counts (a snub)
      state.fighters.forEach((f, p) => {
        if (seen[p][seen[p].length - 1] !== f.action) seen[p].push(f.action);
        if (f.action === "handshake" && offered[p] === undefined) offered[p] = i;
      });
      closest = Math.min(closest, state.fighters[1].position.x - state.fighters[0].position.x);
      if (state.fighters.every((f) => f.action === "handshake")) {
        const [a, b] = [worldHand(sim, geometries[0], 0), worldHand(sim, geometries[1], 1)];
        expect(a.x).toBeCloseTo(b.x, 6);
        expect(a.y).toBeCloseTo(b.y, 6);
      }
    }
    for (const actions of seen) expect(actions).toEqual(["walk", "idle", "handshake", "walk", "idle"]);
    // A pause once they're in place, then player 1 offers a hand and player 2 takes it.
    expect(offered[0]).toBe(INTRO.walkIn + INTRO.pause);
    expect(offered[1]).toBe(offered[0] + SECOND_HAND_FRAMES);
    expect(closest).toBeCloseTo(sim.handshakePositions()[1] - sim.handshakePositions()[0], 6);
    expect(sim.current.fighters.map((f) => f.position.x)).toEqual(start);
    expect(sim.step([idle, idle]).events).toContainEqual({ type: "fight" });
  });

  it("meets in the middle with sides swapped in round 2", () => {
    const sim = new FightSimulation([geo, tallHandshake()]);
    const [p1, p2] = [sim.handshakePositions(1), sim.handshakePositions(2)];
    expect(p1[0]).toBeLessThan(p1[1]);
    expect(p2[0]).toBeGreaterThan(p2[1]);
    expect(p1[0] - 640).toBeCloseTo(640 - p2[0], 6);
  });

  it("walks at a walking pace", () => {
    const sim = new FightSimulation([geo, geo]);
    const distance = sim.handshakePositions()[0] - sim.current.fighters[0].position.x;
    expect(distance / INTRO.walkIn).toBeGreaterThan(2);
    expect(distance / INTRO.walkIn).toBeLessThan(6);
  });

  it("holds each hand out once it's there, and shakes both in step once both are", () => {
    const sim = new FightSimulation([geo, geo]);
    const tween = (k: number, player: 0 | 1) => {
      const step = introStep(k, player);
      return handshakeShakeOf({ ...sim.current.fighters[player], action: step.action, actionFrame: step.actionFrame }, sim.grips[player].offeredAt);
    };
    const offer = INTRO.walkIn + INTRO.pause;
    expect(tween(offer, 0)).toBeNull(); // reaching out
    expect(tween(offer + REACH_FRAMES, 0)).toMatchObject({ from: { poseId: "handshake", variant: 1 }, to: { poseId: "handshake", variant: 2 }, t: 0.5 });
    expect(tween(offer + REACH_FRAMES, 1)).toBeNull(); // still waiting
    expect(tween(offer + SECOND_HAND_FRAMES + 1, 1)).toBeNull(); // reaching out
    expect(tween(offer + SHAKE_START_FRAME - 1, 1)?.t).toBe(0.5); // hands together, not shaking yet
    for (const k of [SHAKE_START_FRAME, SHAKE_START_FRAME + 4, SHAKE_START_FRAME + 13]) {
      expect(tween(offer + k, 0)?.t).toBe(tween(offer + k, 1)?.t);
    }
    expect(tween(offer + SHAKE_START_FRAME + 4, 0)!.t).toBeGreaterThan(0.6);
    expect(tween(offer + INTRO.shake, 0)).toBeNull();
  });

  /** Runs a whole intro with player 2 holding back (away from player 1) for the first `holdFrames` frames. */
  function snubbedIntro(holdFrames: number) {
    const sim = new FightSimulation([geo, geo]);
    const states: FightState[] = [];
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) states.push(sim.step([idle, i < holdFrames ? input({ right: true }) : idle]));
    return { sim, states, events: states.flatMap((s) => s.events) };
  }

  it("refuses the handshake when a fighter holds back on the way in", () => {
    const { sim, states, events } = snubbedIntro(10);
    const offer = INTRO.walkIn + INTRO.pause;
    expect(events.filter((e) => e.type === "snub")).toEqual([{ type: "snub", player: 1 }]);
    // Announced as player 2 turns their back, where they'd have taken the hand.
    const at = states.findIndex((s) => s.events.some((e) => e.type === "snub"));
    expect(at).toBe(snubDueFrame(1) + 1);
    expect(states[at].fighters[1]).toMatchObject({ action: "idle", facing: 1 });
    expect(states[at - 1].fighters[1].facing).toBe(-1);
    // Player 2 never shakes; player 1's hand stays out, never pumped.
    expect(states.some((s) => s.fighters[1].action === "handshake")).toBe(false);
    const p1 = states.slice(offer, offer + INTRO.shake).map((s) => s.fighters[0]);
    expect(p1.every((f) => f.action === "handshake")).toBe(true);
    for (const f of p1) expect(handshakeShakeOf(f, sim.grips[0].offeredAt)?.t ?? 0.5).toBe(0.5);
    // Walks back with their back turned, then faces up for the fight.
    expect(states[offer + INTRO.shake + 10].fighters[1]).toMatchObject({ action: "walk", facing: 1 });
    expect(sim.current.fighters[1].facing).toBe(-1);
    expect(sim.current.round.phase).toBe("fighting");
  });

  it("only counts holding back before the hand is due, and starts over each round", () => {
    expect(snubbedIntro(snubDueFrame(1) + 1).events.some((e) => e.type === "snub")).toBe(true);
    const late = new FightSimulation([geo, geo]);
    const lateEvents: FightEvent[] = [];
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) lateEvents.push(...late.step([idle, i > snubDueFrame(1) ? input({ right: true }) : idle]).events);
    expect(lateEvents.some((e) => e.type === "snub")).toBe(false);

    const { sim } = snubbedIntro(10);
    sim.restartRound();
    const again: FightEvent[] = [];
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) again.push(...sim.step([idle, idle]).events);
    expect(again.some((e) => e.type === "snub")).toBe(false);
  });

  it("leaves both turned away when both refuse", () => {
    const sim = new FightSimulation([geo, geo]);
    const events: FightEvent[] = [];
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) events.push(...sim.step([input({ left: true }), input({ right: true })]).events);
    expect(events.filter((e) => e.type === "snub").map((e) => e.type === "snub" && e.player).sort()).toEqual([0, 1]);
    expect(introStep(INTRO.walkIn + INTRO.pause + SECOND_HAND_FRAMES, 0, [true, true])).toMatchObject({ action: "idle", turnedAway: true });
    expect(introStep(INTRO.walkIn + INTRO.pause + SECOND_HAND_FRAMES, 1, [true, true])).toMatchObject({ action: "idle", turnedAway: true });
  });

  it("warps the one handshake photo between two made-up hands", () => {
    const [grip] = handshakeGrips([geo, geo]);
    const landmarks = buildStickFigureLandmarks("handshake");
    // A solid block of pixels around the figure is enough to warp.
    const data = new Uint8ClampedArray(512 * 512 * 4);
    for (let y = 150; y < 490; y++) for (let x = 180; x < 380; x++) data[(y * 512 + x) * 4 + 3] = 255;
    const source = (frame: FrameRef): TweenSource => ({
      mask: { width: 512, height: 512, data },
      landmarks: frame.variant ? shakenGrip(grip, frame.variant === 1 ? -1 : 1) : landmarks,
      anchor: groundAnchorFor(geo, "handshake"),
      standIn: frame.variant > 0,
    });
    const layers = new PoseTweener(source).layers({ from: { poseId: "handshake", variant: 1 }, to: { poseId: "handshake", variant: 2 }, t: 0.5 });
    expect(layers).toHaveLength(1);
    expect(layers![0]).toMatchObject({ frame: { poseId: "handshake", variant: 0 }, alpha: 1 });
  });
});
