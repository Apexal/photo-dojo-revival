import { describe, expect, it } from "vitest";
import { ARCHETYPES, ARCHETYPE_IDS, archetypeOfMove, type ArchetypeId } from "../src/shared/archetypes";
import { ATTACKS, GRABS, PARRY, PARRY_TOTAL_FRAMES, THROW, attackTotalFrames, canonicalReach, grabTotalFrames, poseAtFrame } from "../src/shared/frame-data";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, frameOf, type FightEvent } from "../src/simulation/fight-simulation";
import { input, type InputFrame } from "../src/simulation/input-frame";
import { MAX_HEALTH, ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const idle = input();
const signature = input({ down: true, punch: true, kick: true });
const geo = (archetype: ArchetypeId = "brawler") => stickFigureGeometry(archetype);

/** P1 of `archetype` against a brawler, past the intro, `gap` px apart around the stage centre. */
function fightingSim(archetype: ArchetypeId, gap = 150): FightSimulation {
  const sim = new FightSimulation([geo(archetype), geo()], { startPositions: [640 - gap / 2, 640 + gap / 2] });
  for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([idle, idle]);
  return sim;
}

function run(sim: FightSimulation, frames: number, p1: InputFrame = idle, p2: InputFrame = idle): FightEvent[] {
  const events: FightEvent[] = [];
  for (let i = 0; i < frames; i++) events.push(...sim.step([p1, p2]).events);
  return events;
}

/** Press once, then hold `hold` (default nothing) for the rest. */
function press(sim: FightSimulation, frames: number, p1: InputFrame, p2: InputFrame = idle, hold: InputFrame = idle): FightEvent[] {
  return [...sim.step([p1, p2]).events, ...run(sim, frames - 1, hold, p2)];
}

describe("archetypes", () => {
  it("each has one signature move, and each move belongs to one archetype", () => {
    const moves = ARCHETYPE_IDS.map((a) => ARCHETYPES[a].move);
    expect(new Set(moves).size).toBe(ARCHETYPE_IDS.length);
    for (const a of ARCHETYPE_IDS) expect(archetypeOfMove(ARCHETYPES[a].move)).toBe(a);
    expect(archetypeOfMove("punch")).toBeNull();
  });

  it("signature sequences add up to their frame data and show the signature pose", () => {
    for (const id of ["charge", "flyingKnee"] as const) {
      const attack = ATTACKS[id];
      expect(attack.sequence.reduce((s, e) => s + e.frames, 0)).toBe(attackTotalFrames(attack));
      expect(poseAtFrame(attack.sequence, attack.startup)).toMatchObject({ poseId: "signature", phase: "active" });
    }
    expect(GRABS.bearHug.sequence.reduce((s, e) => s + e.frames, 0)).toBe(grabTotalFrames(GRABS.bearHug));
    expect(PARRY.sequence.reduce((s, e) => s + e.frames, 0)).toBe(PARRY_TOTAL_FRAMES);
  });

  it("reach of the strike signatures is clamped against their own archetype's stick figure", () => {
    expect(canonicalReach("charge")).toBeGreaterThan(0);
    expect(canonicalReach("flyingKnee")).toBeGreaterThan(0);
  });
});

describe("down + punch + kick", () => {
  it.each(ARCHETYPE_IDS)("starts the %s's signature move", (archetype) => {
    const sim = fightingSim(archetype, 400);
    sim.step([signature, idle]);
    expect(sim.current.fighters[0].action).toBe(ARCHETYPES[archetype].move);
  });

  it("without down it's still a throw up close (or a taunt from afar)", () => {
    const close = fightingSim("brawler", 80);
    close.step([input({ punch: true, kick: true }), idle]);
    expect(close.current.fighters[0].action).toBe("throw");
    const far = fightingSim("brawler", 400);
    far.step([input({ punch: true, kick: true }), idle]);
    expect(far.current.fighters[0].action).toBe("taunt");
  });

  it("an uppercut turns into the signature if kick follows within the leniency window", () => {
    const sim = fightingSim("acrobat", 400);
    sim.step([input({ down: true, punch: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("uppercut");
    sim.step([input({ down: true, punch: true, kick: true }), idle]);
    expect(sim.current.fighters[0].action).toBe("flyingKnee");
  });

  it("each fighter's own signature: a brawler and a guardian press the same buttons", () => {
    const sim = new FightSimulation([geo("brawler"), geo("guardian")], { startPositions: [400, 880] });
    run(sim, ROUND_INTRO_FRAMES);
    sim.step([signature, signature]);
    expect(sim.current.fighters.map((f) => f.action)).toEqual(["charge", "parry"]);
  });
});

describe("brawler: shoulder charge", () => {
  it("closes in from beyond kick range and knocks down on hit", () => {
    const sim = fightingSim("brawler", 420);
    const x0 = sim.current.fighters[0].position.x;
    const events = press(sim, ATTACKS.charge.startup + ATTACKS.charge.active, signature);
    expect(events).toContainEqual(expect.objectContaining({ type: "hit", attack: "charge", blocked: false, damage: ATTACKS.charge.damage }));
    expect(events).toContainEqual({ type: "knockdown", player: 1 });
    expect(sim.current.fighters[0].position.x - x0).toBeGreaterThan(150);
  });

  it("a kick from the same spot doesn't reach", () => {
    const sim = fightingSim("brawler", 420);
    const events = press(sim, attackTotalFrames(ATTACKS.kick), input({ kick: true }));
    expect(events.some((e) => e.type === "hit")).toBe(false);
  });

  it("is blocked standing or crouching (mid), and then it's a free punish", () => {
    for (const guard of [input({ right: true }), input({ right: true, down: true })]) {
      const sim = fightingSim("brawler", 420);
      const events = press(sim, ATTACKS.charge.startup + ATTACKS.charge.active, signature, guard);
      expect(events).toContainEqual(expect.objectContaining({ type: "hit", attack: "charge", blocked: true }));
      expect(events.some((e) => e.type === "knockdown")).toBe(false);
      // The defender is free long before the charge recovers: a punch lands.
      run(sim, ATTACKS.charge.blockstun + 2, idle, idle);
      expect(sim.current.fighters[0].action).toBe("charge");
      const punish = press(sim, ATTACKS.punch.startup + 2, idle, input({ punch: true }));
      expect(punish).toContainEqual(expect.objectContaining({ type: "hit", attacker: 1, attack: "punch", blocked: false }));
    }
  });
});

describe("acrobat: flying knee", () => {
  it("is an overhead: it hits through a crouching guard, but a standing guard blocks it", () => {
    const crouched = fightingSim("acrobat", 150);
    const low = press(crouched, ATTACKS.flyingKnee.startup + ATTACKS.flyingKnee.active, signature, input({ right: true, down: true }));
    expect(low).toContainEqual(expect.objectContaining({ type: "hit", attack: "flyingKnee", blocked: false }));
    const standing = fightingSim("acrobat", 150);
    const high = press(standing, ATTACKS.flyingKnee.startup + ATTACKS.flyingKnee.active, signature, input({ right: true }));
    expect(high).toContainEqual(expect.objectContaining({ type: "hit", attack: "flyingKnee", blocked: true }));
  });

  it("frame advantage: +2 on hit, −4 on block", () => {
    const isFree = (a: string) => a === "idle" || a === "walk" || a === "block";
    const advantage = (guard: InputFrame) => {
      const sim = fightingSim("acrobat", 150);
      sim.step([signature, guard]);
      let hit = false, aFree = -1, dFree = -1;
      for (let f = 1; f < 120 && (aFree < 0 || dFree < 0); f++) {
        const s = sim.step([idle, guard]);
        hit ||= s.events.some((e) => e.type === "hit");
        if (!hit || s.fighters.some((x) => x.hitstopFrames > 0)) continue;
        if (aFree < 0 && isFree(s.fighters[0].action)) aFree = f;
        if (dFree < 0 && isFree(s.fighters[1].action)) dFree = f;
      }
      return dFree - aFree;
    };
    expect(advantage(idle)).toBe(2);
    expect(advantage(input({ right: true }))).toBe(-4);
  });
});

describe("grappler: bear hug", () => {
  it("grabs from outside throw range, can't be broken, and does more than a throw", () => {
    const gap = 160; // throw range is ~115 apart, the bear hug's ~185
    const thrown = fightingSim("grappler", gap);
    // The defender crouch-blocks (holding back only blocks once something is coming; otherwise it walks away).
    const guard = input({ down: true });
    expect(press(thrown, THROW.startup + 2, input({ punch: true, kick: true }), guard).some((e) => e.type === "grab")).toBe(false);

    const sim = fightingSim("grappler", gap);
    const events = press(sim, GRABS.bearHug.startup + 1, signature, guard);
    expect(events).toContainEqual({ type: "grab", attacker: 0, defender: 1, grab: "bearHug" });
    // Mashing punch + kick does nothing.
    const later = run(sim, GRABS.bearHug.holdFrames + 1, idle, input({ punch: true, kick: true }));
    expect(later.some((e) => e.type === "throwTech")).toBe(false);
    expect(later).toContainEqual({ type: "throw", attacker: 0, defender: 1, grab: "bearHug", damage: GRABS.bearHug.damage });
    expect(sim.current.fighters[1].health).toBe(MAX_HEALTH - GRABS.bearHug.damage);
    expect(GRABS.bearHug.damage).toBeGreaterThan(THROW.damage);
  });

  it("loses to attacks: a punch during its startup beats it", () => {
    const sim = fightingSim("grappler", 120);
    sim.step([signature, idle]);
    const events = run(sim, GRABS.bearHug.startup + 2, idle, input({ punch: true }));
    expect(events.some((e) => e.type === "grab")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "hit", attacker: 1 }));
  });

  it("whiffs into a long recovery", () => {
    const sim = fightingSim("grappler", 500);
    const events = press(sim, GRABS.bearHug.startup + 2, signature);
    expect(events.some((e) => e.type === "grab")).toBe(false);
    run(sim, GRABS.bearHug.recovery - 3);
    expect(sim.current.fighters[0].action).toBe("bearHug");
  });
});

describe("guardian: parry", () => {
  /** P2 (a brawler) attacks with `attackInput` on frame 0; P1 parries so its hit (frame `startup`) falls inside the window. */
  function parried(attackInput: InputFrame, startup: number, gap: number) {
    const sim = fightingSim("guardian", gap);
    const parryAt = Math.max(0, startup - PARRY.startup - 2);
    const events: FightEvent[] = [];
    for (let f = 0; f < startup + 4; f++) events.push(...sim.step([f === parryAt ? signature : idle, f === 0 ? attackInput : idle]).events);
    return { sim, events };
  }

  it.each([
    ["a punch (high)", input({ punch: true }), ATTACKS.punch.startup],
    ["a kick (mid)", input({ kick: true }), ATTACKS.kick.startup],
    ["a low kick (low)", input({ down: true, kick: true }), ATTACKS.lowKick.startup],
    ["a shoulder charge", signature, ATTACKS.charge.startup],
  ] as const)("catches %s: no damage, the attacker staggers, the guardian is free", (_name, attackInput, startup) => {
    const gap = attackInput === signature ? 300 : 150;
    const { sim, events } = parried(attackInput, startup, gap);
    const parry = events.find((e) => e.type === "parry");
    expect(parry).toMatchObject({ type: "parry", player: 0, attacker: 1 });
    expect(events.some((e) => e.type === "hit")).toBe(false);
    expect(sim.current.fighters[0].health).toBe(MAX_HEALTH);
    expect(sim.current.fighters[1].action).toBe("parried");
    // Free punish: a punch lands before the stagger ends.
    run(sim, 8); // the hitstop
    const punish = press(sim, ATTACKS.punch.startup + 2, input({ punch: true }));
    expect(punish).toContainEqual(expect.objectContaining({ type: "hit", attacker: 0, attack: "punch", blocked: false }));
  });

  it("doesn't stop a throw", () => {
    const sim = fightingSim("guardian", 80);
    sim.step([signature, input({ punch: true, kick: true })]);
    const events = run(sim, THROW.startup + 1);
    expect(events).toContainEqual({ type: "grab", attacker: 1, defender: 0, grab: "throw" });
  });

  it("only catches during its active frames: too early and the hit lands", () => {
    const sim = fightingSim("guardian", 300);
    sim.step([signature, input({ down: true, punch: true, kick: true })]); // parry at once vs a 14-frame charge
    const events = run(sim, ATTACKS.charge.startup + ATTACKS.charge.active);
    expect(events.some((e) => e.type === "parry")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: "hit", attacker: 1, attack: "charge", blocked: false }));
  });

  it("shows the signature capture while it's up", () => {
    const sim = fightingSim("guardian", 400);
    press(sim, PARRY.startup + 1, signature);
    expect(frameOf(sim.current.fighters[0])).toEqual({ poseId: "signature", variant: 0 });
  });
});

describe("edge cases", () => {
  it("a parry pressed again as the last one ends uses up its press: no stray throw after it catches something", () => {
    const sim = fightingSim("guardian", 150);
    sim.step([signature, idle]);
    run(sim, PARRY_TOTAL_FRAMES - 2);
    // P2 throws a punch timed to land on the next parry's first catching frame; P1 presses again
    // on the frame the parry ends, so it goes straight into a new one.
    sim.step([idle, input({ punch: true })]);
    sim.step([signature, idle]);
    expect(sim.current.fighters[0]).toMatchObject({ action: "parry", actionFrame: 0 });
    const events = run(sim, PARRY.startup);
    expect(events.some((e) => e.type === "parry")).toBe(true);
    // Nothing pressed since: after the hit freeze P1 stays in neutral.
    const after = run(sim, 20);
    expect(after.some((e) => e.type === "grab")).toBe(false);
    expect(["throw", "parry", "taunt"]).not.toContain(sim.current.fighters[0].action);
  });

  it("the bell during a bear hug lets the grabbed fighter go instead of freezing them", () => {
    const sim = fightingSim("grappler", 150);
    // Wind the clock down so time runs out mid-hold.
    const round = sim.current.round;
    (sim.current as { round: typeof round }).round = { ...round, framesRemaining: GRABS.bearHug.startup + 4 };
    press(sim, GRABS.bearHug.startup + 1, signature, input({ down: true }));
    expect(sim.current.fighters[1].action).toBe("grabbed");
    run(sim, 10);
    expect(sim.current.round.phase).not.toBe("fighting");
    expect(sim.current.fighters[1].action).not.toBe("grabbed");
  });
});
