import { describe, expect, it } from "vitest";
import { ATTACKS, THROW } from "../src/shared/frame-data";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, antiAirImmune, frameOf, hurtboxesOf, worldBoxesOf, type FightEvent, type FightState } from "../src/simulation/fight-simulation";
import { createFighterState, currentAttackPhase } from "../src/simulation/fighter-state-machine";
import { JUMP_IMPULSE, WALK_SPEED, blockedDamage } from "../src/simulation/fighter-state-machine";
import { JUMP_SQUAT_FRAMES } from "../src/shared/frame-data";
import { input, type InputFrame } from "../src/simulation/input-frame";
import { MAX_HEALTH, ROUND_FRAMES, ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const geo = stickFigureGeometry();
const idle = input();

/** A sim already past the round intro, fighters `gap` px apart around the stage center. */
function fightingSim(gap = 150): FightSimulation {
  const sim = new FightSimulation([geo, geo], { startPositions: [640 - gap / 2, 640 + gap / 2] });
  for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([idle, idle]);
  expect(sim.current.round.phase).toBe("fighting");
  return sim;
}

function run(sim: FightSimulation, frames: number, p1: InputFrame = idle, p2: InputFrame = idle): FightEvent[] {
  const events: FightEvent[] = [];
  for (let i = 0; i < frames; i++) events.push(...sim.step([p1, p2]).events);
  return events;
}

describe("FightSimulation", () => {
  it("ignores input during the round intro, then announces the fight", () => {
    const sim = new FightSimulation([geo, geo]);
    const start = sim.current.fighters[0].position.x;
    const events = run(sim, ROUND_INTRO_FRAMES - 1, input({ right: true }));
    expect(sim.current.fighters[0].position.x).toBe(start);
    expect(events.some((e) => e.type === "fight")).toBe(false);
    expect(sim.step([idle, idle]).events).toContainEqual({ type: "fight" });
  });

  it("walks at 4 px/frame and faces the opponent", () => {
    const sim = fightingSim(600);
    const x0 = sim.current.fighters[0].position.x;
    run(sim, 10, input({ right: true }));
    expect(sim.current.fighters[0].position.x).toBe(x0 + 10 * WALK_SPEED);
    expect(sim.current.fighters[0].action).toBe("walk");
    expect(sim.current.fighters[0].facing).toBe(1);
    expect(sim.current.fighters[1].facing).toBe(-1);
  });

  it("jumps with gravity and lands back on the floor", () => {
    const sim = fightingSim(600);
    let s = sim.step([input({ up: true }), idle]);
    expect(s.fighters[0].action).toBe("jumpSquat"); // 3-frame wind-up on the ground
    for (let i = 1; i < JUMP_SQUAT_FRAMES; i++) s = sim.step([idle, idle]);
    expect(s.fighters[0].position.y).toBe(0);
    s = sim.step([idle, idle]);
    expect(s.fighters[0].action).toBe("jump");
    expect(s.fighters[0].position.y).toBeLessThan(0);
    let minY = 0;
    let frames = 1;
    while (s.fighters[0].action === "jump" && frames < 200) {
      s = sim.step([idle, idle]);
      minY = Math.min(minY, s.fighters[0].position.y);
      frames++;
    }
    expect(s.fighters[0].position.y).toBe(0);
    expect(s.fighters[0].action).toBe("idle");
    expect(minY).toBeLessThan(-150);
    expect(frames).toBeGreaterThan(40);
    expect(frames).toBeLessThan(50);
  });

  it("punch connects on frame 5 and applies damage, hitstun, pushback", () => {
    const sim = fightingSim(150);
    const defenderX = sim.current.fighters[1].position.x;
    const states: FightState[] = [];
    states.push(sim.step([input({ punch: true }), idle]));
    for (let i = 0; i < 3; i++) states.push(sim.step([idle, idle]));
    expect(states.every((s) => !s.events.some((e) => e.type === "hit"))).toBe(true);
    expect(states.map((s) => s.fighters[0].action)).toEqual(["punch", "punch", "punch", "punch"]);

    const hitFrame = sim.step([idle, idle]); // frame 5
    expect(hitFrame.events).toContainEqual({ type: "hit", attacker: 0, defender: 1, attack: "punch", blocked: false, damage: 8 });
    expect(hitFrame.fighters[1].health).toBe(MAX_HEALTH - ATTACKS.punch.damage);
    expect(hitFrame.fighters[1].action).toBe("hurt");
    expect(hitFrame.fighters[1].stunFrames).toBe(ATTACKS.punch.hitstun);
    expect(hitFrame.fighters[1].position.x).toBe(defenderX + ATTACKS.punch.pushback);
  });

  it("emits attackActive on the first active frame", () => {
    const sim = fightingSim(600);
    const events = run(sim, 1, input({ kick: true }));
    expect(events.some((e) => e.type === "attackActive")).toBe(false);
    const later = run(sim, ATTACKS.kick.startup);
    expect(later.filter((e) => e.type === "attackActive")).toEqual([{ type: "attackActive", player: 0, attack: "kick" }]);
  });

  it("attacks are edge-triggered: holding the button doesn't repeat", () => {
    const sim = fightingSim(600);
    run(sim, 40, input({ punch: true }));
    expect(sim.current.fighters[0].action).toBe("idle");
  });

  it("hitstop freezes both fighters for 4 frames", () => {
    const sim = fightingSim(150);
    run(sim, 5, input({ punch: true }), idle);
    const atHit = sim.current;
    expect(atHit.fighters[0].hitstopFrames).toBe(4);
    expect(atHit.fighters[1].hitstopFrames).toBe(4);
    for (let i = 0; i < 4; i++) {
      const s = sim.step([input({ right: true }), input({ right: true })]);
      expect(s.fighters[0].position).toEqual(atHit.fighters[0].position);
      expect(s.fighters[1].position).toEqual(atHit.fighters[1].position);
      expect(s.fighters[0].actionFrame).toBe(atHit.fighters[0].actionFrame);
      expect(s.fighters[1].actionFrame).toBe(atHit.fighters[1].actionFrame);
      expect(s.round.framesRemaining).toBe(atHit.round.framesRemaining);
    }
    const resumed = sim.step([idle, idle]);
    expect(resumed.fighters[0].actionFrame).toBe(atHit.fighters[0].actionFrame + 1);
  });

  it("an attack hits only once", () => {
    const sim = fightingSim(150);
    const events = run(sim, 30, idle);
    expect(events.length).toBe(0);
    const hits = run(sim, 30, input({ kick: true })).filter((e) => e.type === "hit");
    expect(hits).toHaveLength(1);
  });

  it("holding back against an incoming attack blocks for 25% damage and no hitstun", () => {
    const sim = fightingSim(150);
    // P2 faces left, so "back" is right.
    const events = run(sim, 10, input({ punch: true }), input({ right: true }));
    const hit = events.find((e) => e.type === "hit");
    expect(hit).toEqual({ type: "hit", attacker: 0, defender: 1, attack: "punch", blocked: true, damage: blockedDamage(ATTACKS.punch.damage) });
    expect(blockedDamage(ATTACKS.punch.damage)).toBe(2);
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH - 2);
    expect(sim.current.fighters[1].action).toBe("blockstun");
  });

  it("crouch-block with down also blocks", () => {
    const sim = fightingSim(150);
    const hit = run(sim, 12, input({ kick: true }), input({ down: true })).find((e) => e.type === "hit");
    expect(hit).toMatchObject({ blocked: true, damage: 3 });
  });

  it("holding back with no threat walks backward", () => {
    const sim = fightingSim(300);
    const x = sim.current.fighters[1].position.x;
    run(sim, 5, idle, input({ right: true }));
    expect(sim.current.fighters[1].action).toBe("walk");
    expect(sim.current.fighters[1].position.x).toBe(x + 5 * WALK_SPEED);
  });

  it("punches whiff at long range", () => {
    const sim = fightingSim(600);
    expect(run(sim, 20, input({ punch: true })).some((e) => e.type === "hit")).toBe(false);
  });

  it("trades are resolved simultaneously", () => {
    const sim = fightingSim(150);
    const hits = run(sim, 6, input({ punch: true }), input({ punch: true })).filter((e) => e.type === "hit");
    expect(hits).toHaveLength(2);
    expect(sim.current.fighters[0].health).toBe(MAX_HEALTH - 8);
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH - 8);
  });

  it("fighters push each other apart instead of overlapping", () => {
    const sim = fightingSim(300);
    run(sim, 120, input({ right: true }), input({ left: true }));
    const [a, b] = sim.current.fighters.map((f) => worldBoxesOf(geo, f).bodyBox);
    expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1e-6);
    expect(sim.current.fighters[0].position.x).toBeLessThan(sim.current.fighters[1].position.x);
  });

  it("KO ends the round and the winner poses", () => {
    const sim = fightingSim(150);
    const events: FightEvent[] = [];
    for (let i = 0; i < 1000 && sim.current.round.phase === "fighting"; i++) {
      // Walk in and punch (press/release) while P2 stands still; pushback keeps opening the gap.
      events.push(...sim.step([input({ punch: i % 20 === 0, right: true }), idle]).events);
    }
    expect(sim.current.fighters[1].health).toBe(0);
    expect(sim.current.fighters[1].action).toBe("ko");
    expect(events).toContainEqual({ type: "ko", player: 1 });
    expect(events).toContainEqual({ type: "roundEnd", outcome: 0, reason: "ko" });
    run(sim, 30);
    expect(sim.current.fighters[0].action).toBe("win");
    expect(sim.current.round.wins).toEqual([1, 0]);
  });

  it("timer expiry gives the round to the healthier fighter, then the next round resets", () => {
    const sim = fightingSim(150);
    run(sim, 6, input({ punch: true }));
    const events = run(sim, ROUND_FRAMES);
    expect(events).toContainEqual({ type: "roundEnd", outcome: 0, reason: "timeout" });
    run(sim, 200);
    expect(sim.current.round.phase).toBe("roundOver");
    const next = sim.startNextRound();
    expect(next.round.roundNumber).toBe(2);
    expect(next.round.phase).toBe("intro");
    expect(next.fighters[1].health).toBe(MAX_HEALTH);
    expect(next.events).toEqual([{ type: "roundStart", round: 2 }]);
  });

  it("restarting a round resets positions, health and clock", () => {
    const sim = fightingSim(150);
    const start = sim.current.fighters.map((f) => f.position.x);
    run(sim, 6, input({ punch: true, right: true }));
    run(sim, 120, input({ right: true }));
    expect(sim.current.fighters[1].health).toBeLessThan(MAX_HEALTH);
    const restarted = sim.restartRound();
    expect(restarted.round).toMatchObject({ roundNumber: 1, phase: "intro", framesRemaining: ROUND_FRAMES, wins: [0, 0] });
    expect(restarted.fighters.map((f) => f.health)).toEqual([MAX_HEALTH, MAX_HEALTH]);
    expect(restarted.fighters.map((f) => f.position.x)).toEqual(start);
    expect(restarted.events).toEqual([{ type: "roundStart", round: 1 }]);
  });

  it("restarting round 2 keeps round 1's win and the swapped sides", () => {
    const sim = fightingSim(150);
    run(sim, 6, input({ punch: true }));
    run(sim, ROUND_FRAMES + 200);
    expect(sim.current.round.wins).toEqual([1, 0]);
    const round2 = sim.startNextRound();
    run(sim, ROUND_INTRO_FRAMES + 30);
    const restarted = sim.restartRound();
    expect(restarted.round).toMatchObject({ roundNumber: 2, wins: [1, 0], phase: "intro" });
    expect(restarted.fighters.map((f) => f.position.x)).toEqual(round2.fighters.map((f) => f.position.x));
  });

  it("is deterministic for the same input script", () => {
    const script = (i: number): [InputFrame, InputFrame] => [
      input({ right: i % 50 < 30, punch: i % 17 === 0, up: i % 97 === 0 }),
      input({ left: i % 40 < 20, kick: i % 23 === 0, down: i % 61 < 5 }),
    ];
    const a = fightingSim(400);
    const b = fightingSim(400);
    for (let i = 0; i < 1500; i++) {
      a.step(script(i));
      b.step(script(i));
    }
    expect(a.current).toEqual(b.current);
  });
});

describe("pose variants", () => {
  const varied = stickFigureGeometry();

  function hurtVariants(seed: number, geometry = varied): number[] {
    const sim = new FightSimulation([geometry, geometry], { startPositions: [565, 715], seed });
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([idle, idle]);
    const seen: number[] = [];
    for (let n = 0; n < 12; n++) {
      sim.step([input({ punch: true }), idle]);
      for (let i = 0; i < 5; i++) sim.step([idle, idle]);
      seen.push(sim.current.fighters[1].variant);
      for (let i = 0; i < 25; i++) sim.step([input({ right: true }), idle]);
    }
    return seen;
  }

  it("hit reactions pick randomly between the main pose and its alternates", () => {
    expect(new Set(hurtVariants(7))).toEqual(new Set([0, 1]));
  });

  it("is deterministic per seed", () => {
    expect(hurtVariants(7)).toEqual(hurtVariants(7));
    expect(hurtVariants(7)).not.toEqual(hurtVariants(9));
  });


  it("attacks are never random: a punch always shows the main punch", () => {
    const f = { ...new FightSimulation([varied, varied]).current.fighters[0], action: "punch" as const, actionFrame: 5, variant: 1 };
    expect(frameOf(f)).toEqual({ poseId: "punch", variant: 0 });
  });

  it("uppercut and low kick show their bonus captures on active frames", () => {
    const f = new FightSimulation([varied, varied]).current.fighters[0];
    expect(frameOf({ ...f, action: "uppercut", actionFrame: ATTACKS.uppercut.startup })).toEqual({ poseId: "punch", variant: 1 });
    expect(frameOf({ ...f, action: "lowKick", actionFrame: ATTACKS.lowKick.startup })).toEqual({ poseId: "kick", variant: 1 });
    expect(frameOf({ ...f, action: "uppercut", actionFrame: 1 }).variant).toBe(0);
    expect(frameOf({ ...f, action: "ko" as const, variant: 1 })).toEqual({ poseId: "hurt", variant: 1 });
  });

  it("an uppercut's hitbox is higher than a punch's", () => {
    const f = new FightSimulation([varied, varied]).current.fighters[0];
    const punch = worldBoxesOf(varied, { ...f, action: "punch", actionFrame: ATTACKS.punch.startup }).hitbox!;
    const upper = worldBoxesOf(varied, { ...f, action: "uppercut", actionFrame: ATTACKS.uppercut.startup }).hitbox!;
    expect(upper.y).toBeLessThan(punch.y - 30);
  });
});

describe("moves from inputs", () => {
  it("down + punch = uppercut, down + kick = low kick, plain buttons = punch / kick", () => {
    const start = (p: Partial<InputFrame>) => fightingSim(600).step([input(p), idle]).fighters[0].action;
    expect(start({ punch: true })).toBe("punch");
    expect(start({ kick: true })).toBe("kick");
    expect(start({ punch: true, down: true })).toBe("uppercut");
    expect(start({ kick: true, down: true })).toBe("lowKick");
    expect(start({ punch: true, kick: true })).toBe("taunt"); // far away
    expect(fightingSim(100).step([input({ punch: true, kick: true }), idle]).fighters[0].action).toBe("throw");
  });

  it("an uppercut connects up close", () => {
    const sim = fightingSim(150);
    const events = run(sim, ATTACKS.uppercut.startup + 1, input({ punch: true, down: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: "hit", attack: "uppercut", damage: ATTACKS.uppercut.damage }));
  });
});

describe("frame advantage", () => {
  const isFree = (a: string) => a === "idle" || a === "walk" || a === "block";

  /** Defender's free frame minus attacker's free frame (positive = attacker acts first). */
  function advantage(press: Partial<InputFrame>, blocked: boolean, gap = 120): number {
    const sim = fightingSim(gap);
    const p2 = blocked ? input({ right: true, ...(press.kick && press.down ? { down: true } : {}) }) : idle;
    sim.step([input(press), p2]);
    let hit = false, aFree = -1, dFree = -1;
    for (let f = 1; f < 120 && (aFree < 0 || dFree < 0); f++) {
      const s = sim.step([idle, p2]);
      hit ||= s.events.some((e) => e.type === "hit");
      if (!hit || s.fighters.some((x) => x.hitstopFrames > 0)) continue;
      const [a, d] = s.fighters;
      if (aFree < 0 && isFree(a.action)) aFree = f;
      if (dFree < 0 && isFree(d.action)) dFree = f;
    }
    expect(hit).toBe(true);
    return dFree - aFree;
  }

  it.each([
    ["punch: +3 on hit, −3 on block", { punch: true }, 3, -3],
    ["kick: +2 on hit, −6 on block", { kick: true }, 2, -6],
    ["uppercut: +2 on hit, −8 on block", { punch: true, down: true }, 2, -8],
    ["low kick: +1 on hit, −4 on block", { kick: true, down: true }, 1, -4],
  ] as const)("%s", (_name, press, onHit, onBlock) => {
    expect(advantage(press, false)).toBe(onHit);
    expect(advantage(press, true)).toBe(onBlock);
  });

  it("blocked hits lock the defender in block (blockstun), even if they let go", () => {
    const sim = fightingSim(150);
    run(sim, ATTACKS.punch.startup + 1, input({ punch: true }), input({ right: true }));
    const d = sim.current.fighters[1];
    expect(d.action).toBe("blockstun");
    expect(d.stunFrames).toBe(ATTACKS.punch.blockstun);
    run(sim, 6, idle, input({ left: true })); // tries to walk forward during blockstun
    expect(sim.current.fighters[1].action).toBe("blockstun");
  });
});

describe("air recovery", () => {
  it("a fighter hit out of a jump can't jump again or attack before landing", () => {
    const sim = fightingSim(150);
    sim.step([idle, input({ up: true })]);
    run(sim, 2, idle, idle);
    const events = run(sim, ATTACKS.uppercut.startup + 1, input({ punch: true, down: true }), idle);
    expect(events).toContainEqual(expect.objectContaining({ type: "hit", attack: "uppercut", blocked: false })); // anti-air
    expect(sim.current.fighters[1].position.y).toBeLessThan(0);
    // Mash up + punch while falling.
    for (let i = 0; i < 60 && sim.current.fighters[1].position.y < 0; i++) {
      const s = sim.step([idle, input({ up: true, punch: i % 2 === 0 })]);
      const f = s.fighters[1];
      if (f.position.y < 0) expect(["hurt", "jump", "ko"]).toContain(f.action);
      expect(f.velocity.y).toBeGreaterThanOrEqual(-Math.abs(JUMP_IMPULSE) + 0.6);
    }
  });
});

describe("input buffer", () => {
  it("a press up to 5 frames before recovering still comes out on the first free frame", () => {
    const sim = fightingSim(600);
    sim.step([input({ punch: true }), idle]);
    const total = ATTACKS.punch.startup + ATTACKS.punch.active + ATTACKS.punch.recovery;
    run(sim, total - 5);
    sim.step([input({ kick: true }), idle]); // pressed 4 frames early
    let started = -1;
    for (let f = 1; f <= 6 && started < 0; f++) if (sim.step([idle, idle]).fighters[0].action === "kick") started = f;
    expect(started).toBeGreaterThan(0);
  });

  it("presses older than the buffer are dropped", () => {
    const sim = fightingSim(600);
    sim.step([input({ punch: true }), idle]);
    run(sim, 3);
    sim.step([input({ kick: true }), idle]); // 13 frames before recovery
    expect(run(sim, 30).length).toBe(0);
    expect(sim.current.fighters[0].action).toBe("idle");
  });

  it("presses during hitstop fire right after it", () => {
    const sim = fightingSim(150);
    run(sim, ATTACKS.punch.startup + 1, input({ punch: true }));
    expect(sim.current.fighters[1].hitstopFrames).toBeGreaterThan(0);
    sim.step([idle, input({ punch: true })]); // P2 mashes during hitstop: in hitstun, so it's dropped...
    run(sim, 3);
    expect(sim.current.fighters[1].action).toBe("hurt");
  });
});

describe("throws", () => {
  it("punch + kick within 2 frames is a throw (leniency)", () => {
    const sim = fightingSim(600);
    sim.step([input({ punch: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("punch");
    sim.step([input({ punch: true, kick: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("throw");
  });

  it("beats block: grab, tech window, then damage and a big push", () => {
    const sim = fightingSim(80);
    const events = run(sim, THROW.startup + 1, input({ punch: true, kick: true }), input({ down: true }));
    expect(events).toContainEqual({ type: "grab", attacker: 0, defender: 1 });
    expect(sim.current.fighters[1].action).toBe("grabbed");
    const x = sim.current.fighters[1].position.x;
    const later = run(sim, THROW.techWindow + 1, idle, input({ down: true }));
    expect(later).toContainEqual({ type: "throw", attacker: 0, defender: 1, damage: THROW.damage });
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH - THROW.damage);
    expect(sim.current.fighters[1].action).toBe("hurt");
    expect(sim.current.fighters[1].position.x).toBeGreaterThan(x + 60);
  });

  it("can be teched with punch + kick during the grab", () => {
    const sim = fightingSim(80);
    run(sim, THROW.startup + 1, input({ punch: true, kick: true }));
    expect(sim.current.fighters[1].action).toBe("grabbed");
    const events = run(sim, 2, idle, input({ punch: true, kick: true }));
    expect(events).toContainEqual({ type: "throwTech", attacker: 0, defender: 1 });
    expect(sim.current.fighters.map((f) => f.action)).toEqual(["idle", "idle"]);
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH);
  });

  it("loses to attacks: an opponent mid-punch can't be grabbed", () => {
    const sim = fightingSim(80);
    sim.step([input({ punch: true, kick: true }), idle]);
    sim.step([idle, input({ punch: true })]); // P2 starts a punch during the throw's startup
    const events = run(sim, THROW.startup);
    expect(events.some((e) => e.type === "grab")).toBe(false);
  });

  it("whiffs at range into long recovery (punishable)", () => {
    const sim = fightingSim(200);
    const events = run(sim, THROW.startup + 2, input({ punch: true, kick: true }));
    expect(events.some((e) => e.type === "grab")).toBe(false);
    run(sim, THROW.recovery - 3);
    expect(sim.current.fighters[0].action).toBe("throw");
  });

  it("can't grab someone in hitstun or blockstun", () => {
    const sim = fightingSim(80);
    run(sim, ATTACKS.punch.startup + 1, input({ punch: true }));
    expect(sim.current.fighters[1].action).toBe("hurt");
    run(sim, 6); // wait out hitstop and the punch
    const events = run(sim, THROW.startup + 1, input({ punch: true, kick: true }));
    expect(events.some((e) => e.type === "grab")).toBe(false);
  });
});

describe("practice mode", () => {
  function practiceSim(gap = 150) {
    const sim = new FightSimulation([geo, geo], { startPositions: [640 - gap / 2, 640 + gap / 2], practice: true });
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([idle, idle]);
    return sim;
  }

  it("the clock doesn't run and nobody gets KO'd", () => {
    const sim = practiceSim();
    const events: FightEvent[] = [];
    for (let i = 0; i < 1500; i++) events.push(...sim.step([input({ punch: i % 18 === 0, right: true }), idle]).events);
    expect(sim.current.round.framesRemaining).toBe(ROUND_FRAMES);
    expect(sim.current.round.phase).toBe("fighting");
    expect(events.some((e) => e.type === "ko" || e.type === "roundEnd")).toBe(false);
    expect(events.filter((e) => e.type === "hit").length).toBeGreaterThan(15); // would be a KO in a match
  });

  it("health refills after a second back in neutral", () => {
    const sim = practiceSim();
    run(sim, ATTACKS.punch.startup + 1, input({ punch: true }));
    expect(sim.current.fighters[1].health).toBeLessThan(MAX_HEALTH);
    run(sim, 30);
    expect(sim.current.fighters[1].health).toBeLessThan(MAX_HEALTH);
    run(sim, 60);
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH);
  });
});

describe("high / low", () => {
  /** P1 attacks with `press` (optionally from a jump); P2 holds `guard`. */
  function attackInto(press: Partial<InputFrame>, guard: Partial<InputFrame>, options: { jump?: boolean; gap?: number } = {}) {
    const sim = fightingSim(options.gap ?? 150);
    const p2 = input(guard);
    if (options.jump) {
      sim.step([input({ up: true, right: true }), p2]);
      run(sim, JUMP_SQUAT_FRAMES + 8, input({ right: true }), p2);
    }
    return run(sim, 40, input(press), p2).find((e) => e.type === "hit");
  }

  it("a low kick beats a standing block but not a crouching one", () => {
    expect(attackInto({ kick: true, down: true }, { right: true })).toMatchObject({ attack: "lowKick", blocked: false });
    expect(attackInto({ kick: true, down: true }, { down: true })).toMatchObject({ attack: "lowKick", blocked: true });
  });

  it("a jump kick is an overhead: beats a crouching block, stopped by a standing one", () => {
    expect(attackInto({ kick: true }, { down: true }, { jump: true, gap: 220 })).toMatchObject({ attack: "jumpKick", blocked: false });
    expect(attackInto({ kick: true }, { right: true }, { jump: true, gap: 220 })).toMatchObject({ attack: "jumpKick", blocked: true });
  });

  it("mids (kick, uppercut) are blocked either way", () => {
    for (const press of [{ kick: true }, { down: true, punch: true }]) {
      expect(attackInto(press, { right: true })).toMatchObject({ blocked: true });
      expect(attackInto(press, { down: true })).toMatchObject({ blocked: true });
    }
  });

  it("the punch is high: blocked standing, and it whiffs over a crouching guard", () => {
    expect(attackInto({ punch: true }, { right: true })).toMatchObject({ attack: "punch", blocked: true });
    expect(attackInto({ punch: true }, { down: true })).toBeUndefined();
    // Just standing there, the punch hits as usual.
    expect(attackInto({ punch: true }, {})).toMatchObject({ attack: "punch", blocked: false });
  });

  it("a crouching guard is drawn with the crouch capture; a standing one with the block capture", () => {
    const guardPoses = (guard: Partial<InputFrame>) => {
      const sim = fightingSim(150);
      const poses = new Set<string>();
      for (let f = 0; f < 30; f++) {
        sim.step([input({ kick: f === 0 }), input(guard)]); // an incoming kick, so holding back blocks
        const d = sim.current.fighters[1];
        if (d.action === "block" || d.action === "blockstun") poses.add(frameOf(d).poseId);
      }
      return poses;
    };
    expect(guardPoses({ down: true })).toEqual(new Set(["crouch"]));
    expect(guardPoses({ right: true })).toEqual(new Set(["block"]));
  });

  it("one air attack per jump", () => {
    const sim = fightingSim(600);
    sim.step([input({ up: true }), idle]);
    run(sim, JUMP_SQUAT_FRAMES + 3);
    sim.step([input({ kick: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("jumpKick");
    run(sim, ATTACKS.jumpKick.startup + ATTACKS.jumpKick.active + ATTACKS.jumpKick.recovery);
    for (let i = 0; i < 10 && sim.current.fighters[0].position.y < 0; i++) {
      sim.step([input({ kick: i % 2 === 0 }), idle]);
      expect(sim.current.fighters[0].action).not.toBe("jumpKick");
    }
  });

  it("landing cancels the rest of a jump kick", () => {
    const sim = fightingSim(600);
    sim.step([input({ up: true }), idle]);
    run(sim, JUMP_SQUAT_FRAMES + 30);
    sim.step([input({ kick: true }), idle]);
    for (let i = 0; i < 40 && sim.current.fighters[0].position.y < 0; i++) sim.step([idle, idle]);
    expect(sim.current.fighters[0].action).toBe("idle");
  });
});

describe("forgiveness", () => {
  it("a block counts if back was let go within the last 3 frames", () => {
    const sim = fightingSim(150);
    // P2 holds back, then releases right as the punch lands.
    sim.step([input({ punch: true }), input({ right: true })]);
    run(sim, 2, idle, input({ right: true }));
    const hit = run(sim, 6, idle, idle).find((e) => e.type === "hit");
    expect(hit).toMatchObject({ blocked: true });
  });

  it("…but not if they let go longer ago", () => {
    const sim = fightingSim(150);
    sim.step([idle, input({ right: true })]);
    run(sim, 6, idle, idle);
    const hit = run(sim, 10, input({ punch: true }), idle).find((e) => e.type === "hit");
    expect(hit).toMatchObject({ blocked: false });
  });

  it("a jump's wind-up can still turn into a block", () => {
    const sim = fightingSim(150);
    sim.step([input({ punch: true }), input({ up: true })]); // P2 jumps into an incoming punch...
    sim.step([idle, input({ right: true })]); // ...and changes their mind: hold back
    const hit = run(sim, 6, idle, input({ right: true })).find((e) => e.type === "hit");
    expect(hit).toMatchObject({ blocked: true });
  });

  it("chip damage from blocking can't finish a round", () => {
    const sim = fightingSim(150);
    (sim as unknown as { state: FightState }).state.fighters[1].health = 2;
    run(sim, 30, input({ kick: true }), input({ right: true }));
    expect(sim.current.fighters[1].health).toBe(1);
    expect(sim.current.round.phase).toBe("fighting");
  });
});

describe("sides", () => {
  it("airborne fighters can cross over each other (cross-up), then push apart on landing", () => {
    const sim = fightingSim(160);
    sim.step([input({ up: true, right: true }), idle]);
    let crossed = false;
    for (let i = 0; i < 60; i++) {
      const s = sim.step([input({ right: true }), idle]);
      if (s.fighters[0].position.x > s.fighters[1].position.x) crossed = true;
    }
    expect(crossed).toBe(true);
    const [a, b] = sim.current.fighters;
    expect(a.position.x).toBeGreaterThan(b.position.x); // landed on the other side
    expect(a.facing).toBe(-1);
    expect(b.facing).toBe(1);
  });

  it("pushback always goes away from the attacker", () => {
    const sim = fightingSim(150);
    const x = sim.current.fighters[0].position.x;
    run(sim, 5, idle, input({ punch: true }));
    expect(sim.current.fighters[0].position.x).toBeLessThan(x);
  });

  it("players swap sides every round", () => {
    const sim = fightingSim(150);
    run(sim, ROUND_FRAMES + 200);
    const r2 = sim.startNextRound();
    expect(r2.fighters[0].position.x).toBeGreaterThan(r2.fighters[1].position.x);
    expect(r2.fighters[0].facing).toBe(-1);
  });
});

describe("taunt", () => {
  it("punch + kick from far away taunts: an event, the win pose, and you're wide open", () => {
    const sim = fightingSim(400);
    const events = run(sim, 1, input({ punch: true, kick: true }));
    expect(events).toContainEqual({ type: "taunt", player: 0 });
    expect(frameOf(sim.current.fighters[0]).poseId).toBe("win");
    run(sim, 38, idle, input({ left: true })); // P2 walks into range while the taunt is still running...
    const hit = run(sim, 10, idle, input({ punch: true, left: true })).find((e) => e.type === "hit");
    expect(hit).toMatchObject({ defender: 0, blocked: false });
  });
});

describe("anti-air uppercut", () => {
  it("is immune to airborne attacks during startup and active frames, not to ground attacks or in recovery", () => {
    const up = { ...createFighterState(500, 1, MAX_HEALTH), action: "uppercut" as const, actionFrame: 2 };
    const air = { ...createFighterState(600, -1, MAX_HEALTH), action: "jumpKick" as const, position: { x: 600, y: -80 }, velocity: { x: 0, y: 2 } };
    const ground = { ...createFighterState(600, -1, MAX_HEALTH), action: "punch" as const };
    expect(antiAirImmune(up, air)).toBe(true);
    expect(antiAirImmune(up, ground)).toBe(false);
    const recovering = { ...up, actionFrame: ATTACKS.uppercut.startup + ATTACKS.uppercut.active };
    expect(currentAttackPhase(recovering)).toBe("recovery");
    expect(antiAirImmune(recovering, air)).toBe(false);
  });

  it("beats a jump-in kick when timed right, and is never hit by it during startup or active frames", () => {
    let wins = 0;
    for (let t = 0; t < 40; t++) {
      const sim = fightingSim(200);
      let p1Hit = false, p2Hit = false;
      for (let f = 0; f < 90; f++) {
        const p1Before = sim.current.fighters[0];
        const p2 = input({ up: f < 2, left: f < 4, kick: f === 15 });
        const p1 = input(f === t || f === t + 1 ? { down: true, punch: true } : {});
        for (const e of sim.step([p1, p2]).events) {
          if (e.type !== "hit" || e.blocked) continue;
          if (e.attacker === 0) p1Hit = true;
          else {
            p2Hit = true;
            expect(p1Before.action === "uppercut" && currentAttackPhase(p1Before) !== "recovery").toBe(false);
          }
        }
      }
      if (p1Hit && !p2Hit) wins++;
    }
    expect(wins).toBeGreaterThan(10);
  });
});

describe("hurtboxes don't depend on luck or animation timing", () => {
  it("walking uses the idle hurtboxes on every frame of the stride", () => {
    const sim = fightingSim(400);
    const poses = new Set<string>();
    for (let i = 0; i < 25; i++) {
      sim.step([input({ right: true }), idle]);
      const f = sim.current.fighters[0];
      poses.add(frameOf(f).poseId);
      expect(hurtboxesOf(geo, f).boxes).toEqual(hurtboxesOf(geo, { ...f, action: "idle", actionFrame: 0 }).boxes);
    }
    expect(poses).toEqual(new Set(["walk", "idle"])); // the sprite still strides
  });

  it("random hurt and win alternates are cosmetic: the main pose's hurtboxes count", () => {
    for (const action of ["hurt", "ko", "taunt"] as const) {
      const base = { ...createFighterState(500, 1, MAX_HEALTH), action, variant: 0 };
      const alt = { ...base, variant: 1 };
      expect(frameOf(alt).variant).toBe(1); // the alternate is what's drawn
      expect(hurtboxesOf(geo, alt).boxes).toEqual(hurtboxesOf(geo, base).boxes);
    }
  });
});

describe("spacing: the punch is fast, the kick is long", () => {
  it("the kick lunges forward on its active frames, and stops on contact", () => {
    const whiff = fightingSim(600);
    const x0 = whiff.current.fighters[0].position.x;
    run(whiff, 30, input({ kick: true }));
    expect(whiff.current.fighters[0].position.x - x0).toBeCloseTo(ATTACKS.kick.advance!, 5);

    const blocked = fightingSim(150);
    const b0 = blocked.current.fighters[0].position.x;
    const events = run(blocked, 30, input({ kick: true }), input({ right: true }));
    expect(events.find((e) => e.type === "hit")).toMatchObject({ attack: "kick", blocked: true });
    expect(blocked.current.fighters[0].position.x - b0).toBeLessThan(ATTACKS.kick.advance!);
  });

  it("a kick pressed while holding back comes out in place; forward or neutral lunges", () => {
    const moved = (held: Partial<InputFrame>, kick: Partial<InputFrame> = { kick: true }) => {
      const sim = fightingSim(600);
      const x0 = sim.current.fighters[0].position.x;
      sim.step([input({ ...held, ...kick }), idle]);
      run(sim, ATTACKS.kick.startup + ATTACKS.kick.active + 2, input(held)); // through the kick's active frames
      expect(sim.current.fighters[0].action).toBe("kick");
      return sim.current.fighters[0].position.x - x0;
    };
    expect(moved({})).toBeCloseTo(ATTACKS.kick.advance!, 5);
    expect(moved({ right: true })).toBeCloseTo(ATTACKS.kick.advance!, 5);
    expect(moved({ left: true })).toBe(0); // backing off: the kick comes out in place
    // Down-back + kick: a low kick in place.
    const sim = fightingSim(600);
    const x0 = sim.current.fighters[0].position.x;
    sim.step([input({ down: true, left: true, kick: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("lowKick");
    run(sim, ATTACKS.lowKick.startup + ATTACKS.lowKick.active + 2, input({ down: true, left: true }));
    expect(sim.current.fighters[0].position.x).toBe(x0);
  });

  it("at long range a kick beats a punch thrown at the same time", () => {
    const sim = fightingSim(350);
    const events = run(sim, 40, input({ kick: true }), input({ punch: true }));
    const hits = events.filter((e) => e.type === "hit");
    expect(hits).toEqual([expect.objectContaining({ attacker: 0, attack: "kick", blocked: false })]);
  });

  it("up close the punch still wins the same trade", () => {
    const sim = fightingSim(150);
    const hits = run(sim, 40, input({ kick: true }), input({ punch: true })).filter((e) => e.type === "hit");
    expect(hits[0]).toMatchObject({ attacker: 1, attack: "punch", blocked: false });
  });

  /** P1 kicks then guards; P2 blocks it, then punches as soon as it's free. Did P2's punch land? */
  function punishedAfterBlock(gap: number): boolean {
    const sim = fightingSim(gap);
    let blocked = false, punished = false, answered = false;
    for (let f = 0; f < 80; f++) {
      const d = sim.current.fighters[1];
      const free = blocked && d.action !== "blockstun";
      const p2 = !blocked ? input({ right: true }) : free && !answered ? input({ punch: true }) : idle;
      if (free) answered = true;
      for (const e of sim.step([input(f === 0 ? { kick: true } : f > 1 ? { left: true } : {}), p2]).events) {
        if (e.type === "hit" && e.attacker === 0 && e.blocked) blocked = true;
        if (e.type === "hit" && e.attacker === 1 && !e.blocked) punished = true;
      }
    }
    expect(blocked).toBe(true);
    return punished;
  }

  it("a kick blocked up close is punishable; blocked at the tip of its range it's safe", () => {
    expect(punishedAfterBlock(150)).toBe(true);
    expect(punishedAfterBlock(330)).toBe(false);
  });
});
