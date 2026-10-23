import { describe, expect, it } from "vitest";
import { GamepadInputSource, PAD_BUTTON } from "../src/game/input/gamepad-input-source";
import { signalingBaseUrl, signalingHttpBase, signalingUrl } from "../src/transfer/signaling-client";

function fakePad(pressed: number[] = [], axes: [number, number] = [0, 0], connected = true) {
  return {
    connected,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
    axes: axes.map((v) => ({ getValue: () => v })),
  };
}

function source(pad: ReturnType<typeof fakePad> | null) {
  const plugin = { getPad: () => pad } as never;
  return new GamepadInputSource(plugin, 0);
}

describe("GamepadInputSource", () => {
  it("A = punch, B = kick, d-pad moves", () => {
    expect(source(fakePad([PAD_BUTTON.A, PAD_BUTTON.LEFT])).read()).toEqual({ left: true, right: false, up: false, down: false, punch: true, kick: false });
    expect(source(fakePad([PAD_BUTTON.B, PAD_BUTTON.UP])).read()).toMatchObject({ kick: true, up: true, punch: false });
  });

  it("left stick moves past the deadzone", () => {
    expect(source(fakePad([], [0.2, 0])).read().right).toBe(false);
    expect(source(fakePad([], [0.8, 0])).read().right).toBe(true);
    expect(source(fakePad([], [0, 0.9])).read().down).toBe(true);
  });

  it("Start is edge-triggered", () => {
    const pad = fakePad([]);
    const s = source(pad);
    expect(s.pausePressed()).toBe(false);
    pad.buttons[PAD_BUTTON.START].pressed = true;
    expect(s.pausePressed()).toBe(true);
    expect(s.pausePressed()).toBe(false);
  });

  it("is disconnected as soon as the browser drops the pad, even if Phaser still has it", () => {
    const nav = globalThis.navigator as unknown as { getGamepads?: () => unknown[] };
    const original = nav.getGamepads;
    let live: unknown[] = [{ connected: true }];
    nav.getGamepads = () => live;
    try {
      const s = source(fakePad([], [0, 0], true));
      expect(s.connected).toBe(true);
      live = [null];
      expect(s.connected).toBe(false);
      live = [{ connected: true }];
      expect(s.connected).toBe(true);
    } finally {
      nav.getGamepads = original;
    }
  });

  it("reads nothing until the pad appears", () => {
    const s = source(null);
    expect(s.connected).toBe(false);
    expect(Object.values(s.read()).some(Boolean)).toBe(false);
  });
});

describe("signaling URLs", () => {
  it("uses the configured Worker URL", () => {
    const base = signalingBaseUrl({ VITE_SIGNALING_URL: "wss://sig.example.workers.dev/" }, { protocol: "https:", host: "dojo.pages.dev" });
    expect(base).toBe("wss://sig.example.workers.dev");
    expect(signalingUrl("ABC234", "guest", base)).toBe("wss://sig.example.workers.dev/room/ABC234?role=guest");
    expect(signalingHttpBase(base)).toBe("https://sig.example.workers.dev");
  });

  it("defaults to the page's origin with a matching ws scheme", () => {
    expect(signalingBaseUrl({}, { protocol: "https:", host: "192.168.1.5:5173" })).toBe("wss://192.168.1.5:5173");
    expect(signalingBaseUrl({}, { protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173");
  });
});

import { pickTake } from "../src/game/sound-choice";

describe("voice take choice", () => {
  it("never repeats the previous take when there's another", () => {
    let last: string | undefined;
    for (let i = 0; i < 50; i++) {
      const next = pickTake(["a", "b", "c"], last);
      expect(next).not.toBe(last);
      last = next;
    }
  });

  it("uses the only take when there is one", () => {
    expect(pickTake(["a"], "a")).toBe("a");
  });

  it("covers every take", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(pickTake(["a", "b", "c"], undefined));
    expect(seen.size).toBe(3);
  });
});

import { MOVE_GUIDE, controlLabels } from "../src/game/input/control-labels";

describe("pre-match control labels", () => {
  const how = (name: string, labels: ReturnType<typeof controlLabels>) => MOVE_GUIDE.find((m) => m.name === name)!.how(labels);

  it("P1 keyboard on the left: back is A, forward is D", () => {
    const l = controlLabels({ kind: "keyboard", layout: "p1" }, "left");
    expect(how("Walk", l)).toBe("A / D");
    expect(how("Block", l)).toBe("hold A or S");
    expect(how("Uppercut", l)).toBe("S + J");
    expect(how("Throw", l)).toBe("J + K");
  });

  it("P2 keyboard on the right: back is →, buttons are , and . (no numpad needed)", () => {
    const l = controlLabels({ kind: "keyboard", layout: "p2" }, "right");
    expect(how("Walk", l)).toBe("→ / ←");
    expect(how("Block", l)).toBe("hold → or ↓");
    expect(how("Low kick", l)).toBe("↓ + .");
    expect(how("Throw", l)).toBe(", + .");
  });

  it("gamepads use A/B and the d-pad, mirrored by side", () => {
    const right = controlLabels({ kind: "pad", index: 0 }, "right");
    expect(how("Punch", right)).toBe("Ⓐ");
    expect(how("Walk", right)).toBe("▶ / ◀");
    expect(how("Walk", controlLabels({ kind: "pad", index: 0 }, "left"))).toBe("◀ / ▶");
  });

  it("lists every move a player can do", () => {
    expect(MOVE_GUIDE.map((m) => m.action)).toEqual(["walk", "jump", "block", "punch", "kick", "uppercut", "lowKick", "throw"]);
  });
});

import { DummyInputSource, nextCpuBehavior } from "../src/game/input/dummy-input-source";
import { CpuPlayer, type CpuLevel } from "../src/game/input/cpu-player";
import { stickFigureGeometry } from "../src/shared/stick-figure";
import { FightSimulation, createRng, type FightState } from "../src/simulation/fight-simulation";
import { createFighterState, isDown } from "../src/simulation/fighter-state-machine";
import { input, type InputFrame } from "../src/simulation/input-frame";
import { ROUND_INTRO_FRAMES } from "../src/simulation/round-rules";

const geo = stickFigureGeometry();

/** Just enough of a FightSimulation for the dummy: the player on the left, the dummy facing them. */
function fakeFight() {
  const fight = {
    current: { fighters: [createFighterState(400, 1, 100), createFighterState(600, -1, 100)] } as unknown as FightState,
    getGeometry: () => geo,
    face(dir: 1 | -1) { fight.current.fighters[1].facing = dir; },
  };
  return fight;
}

describe("practice dummy", () => {
  const frames = (d: DummyInputSource, n: number) => Array.from({ length: n }, () => d.read());

  it("blocks by holding away from the player, whichever way it faces", () => {
    const fight = fakeFight();
    const d = new DummyInputSource(fight);
    d.setBehavior("block");
    expect(d.read()).toMatchObject({ right: true, left: false });
    fight.face(1);
    expect(d.read()).toMatchObject({ left: true, right: false });
  });

  it("punches twice a second as press/release (so each is a new press)", () => {
    const d = new DummyInputSource(fakeFight());
    d.setBehavior("punch");
    const presses = frames(d, 60).filter((f, i, all) => f.punch && !(all[i - 1]?.punch));
    expect(presses).toHaveLength(2);
  });

  it("throws with punch + kick together, once per loop", () => {
    const d = new DummyInputSource(fakeFight());
    d.setBehavior("throw");
    const f = frames(d, 60);
    expect(f[0]).toMatchObject({ punch: true, kick: true });
    expect(f.filter((x) => x.punch).length).toBe(2);
  });

  it("mix-it-up picks a scripted behavior each loop", () => {
    let r = 0;
    const d = new DummyInputSource(fakeFight(), 1, () => (r = (r + 0.37) % 1));
    d.setBehavior("random");
    const loops = Array.from({ length: 6 }, () => JSON.stringify(frames(d, 60)));
    expect(new Set(loops).size).toBeGreaterThan(1);
  });

  it("9 cycles the CPU levels", () => {
    expect(nextCpuBehavior("block")).toBe("cpuEasy");
    expect(nextCpuBehavior("cpuEasy")).toBe("cpuNormal");
    expect(nextCpuBehavior("cpuNormal")).toBe("cpuHard");
    expect(nextCpuBehavior("cpuHard")).toBe("cpuEasy");
  });
});

describe("CPU opponent", () => {
  /** P1 is driven by `p1(state)`, P2 by a CPU; returns the final state and the hits. */
  function play(level: CpuLevel, p1: (s: FightState, frame: number) => InputFrame, frames: number, seed = 7) {
    const sim = new FightSimulation([geo, geo], { practice: true, seed });
    const cpu = new CpuPlayer(level, { self: geo, opponent: geo }, createRng(seed));
    for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([input(), input()]);
    const hits = { onCpu: 0, blockedByCpu: 0, byCpu: 0 };
    for (let f = 0; f < frames; f++) {
      const s = sim.current;
      const events = sim.step([p1(s, f), cpu.read(s.fighters[1], s.fighters[0])]).events;
      for (const e of events) {
        if (e.type !== "hit" && e.type !== "throw") continue;
        if (e.attacker === 1) hits.byCpu++;
        else if (e.type === "hit" && e.blocked) hits.blockedByCpu++;
        else hits.onCpu++;
      }
    }
    return { state: sim.current, hits };
  }
  const stand = () => input();
  /** Walks up to the CPU and attacks every half second: punch, kick, low kick. */
  const brawler = (s: FightState, f: number) => {
    const [me, cpu] = s.fighters;
    if (Math.abs(cpu.position.x - me.position.x) >= 200) return input(cpu.position.x > me.position.x ? { right: true } : { left: true });
    const t = f % 120;
    return t === 0 ? input({ punch: true }) : t === 60 ? input({ kick: true }) : t === 90 ? input({ down: true, kick: true }) : input();
  };

  it("walks in and hits an opponent that does nothing, at every level", () => {
    for (const level of ["easy", "normal", "hard"] as const) {
      expect(play(level, stand, 900).hits.byCpu, level).toBeGreaterThan(0);
    }
  });

  it("presses buttons as fresh presses (never holds one down)", () => {
    const cpu = new CpuPlayer("hard", { self: geo, opponent: geo }, createRng(3));
    const a = createFighterState(600, -1, 100);
    const b = createFighterState(530, 1, 100);
    let last = input();
    for (let i = 0; i < 300; i++) {
      const f = cpu.read(a, b);
      expect(f.punch && last.punch).toBe(false);
      expect(f.kick && last.kick).toBe(false);
      last = f;
    }
  });

  it("trades better against the same attacker on harder levels", () => {
    const [easy, normal, hard] = (["easy", "normal", "hard"] as const).map((level) => {
      let landed = 0;
      let taken = 0;
      for (const seed of [1, 2, 3, 4]) {
        const { hits } = play(level, brawler, 1200, seed);
        landed += hits.byCpu;
        taken += hits.onCpu;
      }
      return { landed, taken, ratio: landed / Math.max(1, taken) };
    });
    expect(normal.ratio).toBeGreaterThan(easy.ratio);
    expect(hard.ratio).toBeGreaterThan(normal.ratio);
    expect(hard.taken).toBeLessThan(easy.taken);
  });

  it("opens up a crouch-blocker with throws and jump-ins", () => {
    const { hits } = play("hard", () => input({ down: true }), 1200);
    expect(hits.byCpu).toBeGreaterThan(5);
  });

  it("stops jump-ins on hard far more often than on easy", () => {
    // A jump-in it answers: any clean hit on the jumper while they're in the air.
    const stopped = (level: CpuLevel) => {
      let jumps = 0, answered = 0;
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const sim = new FightSimulation([geo, geo], { practice: true, seed, startPositions: [440, 700] });
        const cpu = new CpuPlayer(level, { self: geo, opponent: geo }, createRng(seed));
        for (let i = 0; i < ROUND_INTRO_FRAMES; i++) sim.step([input(), input()]);
        // Jump in with a kick, then walk back out; start over once back up after a knockdown (an uppercut).
        let t = 0;
        for (let f = 0; f < 600; f++) {
          const s = sim.current;
          t = isDown(s.fighters[0]) ? 0 : (t + 1) % 90;
          const p1 = t < 40 ? input({ right: t < 30, up: t < 3, kick: t === 18 }) : input({ left: t < 70 });
          const next = sim.step([p1, cpu.read(s.fighters[1], s.fighters[0])]);
          if (next.fighters[0].action === "jump" && s.fighters[0].action === "jumpSquat") jumps++;
          const airborne = s.fighters[0].position.y < 0;
          if (airborne && next.events.some((e) => e.type === "hit" && e.defender === 0 && !e.blocked)) answered++;
        }
      }
      return answered / jumps;
    };
    expect(stopped("hard")).toBeGreaterThan(stopped("easy") * 2);
  });
});

import { TapLatch } from "../src/game/input/tap-latch";

describe("keyboard taps", () => {
  const actions = ["punch"] as const;
  const frames = (latch: TapLatch<"punch">, script: ((l: TapLatch<"punch">) => void)[], held = () => false) =>
    script.map((events) => { events(latch); return latch.read(actions, held).punch; });
  const tap = (l: TapLatch<"punch">) => { l.press("punch"); l.release("punch"); };
  const none = () => {};

  it("a tap shorter than a frame reads as one pressed frame", () => {
    expect(frames(new TapLatch(), [tap, none, none])).toEqual([true, false, false]);
  });

  it("back-to-back taps on consecutive frames stay separate presses (a released frame in between)", () => {
    const levels = frames(new TapLatch(), [tap, tap, none, none]);
    expect(levels).toEqual([true, false, true, false]);
    const presses = levels.filter((v, i) => v && !levels[i - 1]).length;
    expect(presses).toBe(2);
  });

  it("holding a key reads as held, every frame", () => {
    let down = false;
    const l = new TapLatch<"punch">();
    const out = [
      (() => { l.press("punch"); down = true; return l.read(actions, () => down).punch; })(),
      l.read(actions, () => down).punch,
      l.read(actions, () => down).punch,
      (() => { l.release("punch"); down = false; return l.read(actions, () => down).punch; })(),
    ];
    expect(out).toEqual([true, true, true, false]);
  });
});

import { RumbleScheduler, intensity, perceptible, playRumble, rumbleFor } from "../src/game/input/rumble";

describe("rumble scheduling", () => {
  const light = { duration: 100, strong: 0.3, weak: 0.45 };
  const heavy = { duration: 260, strong: 1, weak: 0.7 };

  it("effects asked for in the same frame collapse into the strongest", () => {
    const q = new RumbleScheduler();
    q.request(light);
    q.request(heavy);
    q.request(light);
    expect(q.flush(0)).toBe(heavy);
    expect(q.flush(16)).toBeNull();
  });

  it("a weaker effect doesn't cut off a stronger one still playing, but can follow it", () => {
    const q = new RumbleScheduler();
    q.request(heavy);
    q.flush(0);
    q.request(light);
    expect(q.flush(100)).toBeNull(); // heavy still playing
    q.request(light);
    expect(q.flush(300)).toBe(light); // heavy finished
  });

  it("a stronger effect replaces a weaker one right away", () => {
    const q = new RumbleScheduler();
    q.request(light);
    q.flush(0);
    q.request(heavy);
    expect(q.flush(20)).toBe(heavy);
  });
});

describe("controller rumble", () => {
  const hit = (attack: string, blocked: boolean) => ({ type: "hit", attacker: 0, defender: 1, attack, blocked, damage: 8 }) as never;

  it("getting hit rumbles harder than landing the hit, and heavy attacks harder than punches", () => {
    const victimPunch = rumbleFor(hit("punch", false), 1)!;
    const victimKick = rumbleFor(hit("kick", false), 1)!;
    const attacker = rumbleFor(hit("punch", false), 0)!;
    expect(victimKick.strong).toBeGreaterThan(victimPunch.strong);
    expect(victimKick.duration).toBeGreaterThan(victimPunch.duration);
    expect(Math.max(attacker.strong, attacker.weak)).toBeLessThan(Math.max(victimPunch.strong, victimPunch.weak));
  });

  it("blocking is a light tick for the defender and nothing for the attacker", () => {
    expect(intensity(rumbleFor(hit("kick", true), 1)!)).toBeLessThan(intensity(rumbleFor(hit("punch", false), 1)!));
    expect(rumbleFor(hit("kick", true), 0)).toBeNull();
  });

  it("every effect uses the big motor (the one you feel on an Xbox pad)", () => {
    const events = [hit("punch", false), hit("kick", false), hit("punch", true), { type: "grab", attacker: 0, defender: 1 }, { type: "ko", player: 1 }] as never[];
    for (const ev of events) for (const p of [0, 1] as const) {
      const r = rumbleFor(ev, p);
      if (r) expect(r.strong).toBeGreaterThan(0);
    }
  });

  it("throws and KOs are the big ones; announcer events don't rumble", () => {
    expect(rumbleFor({ type: "throw", attacker: 0, defender: 1, damage: 12 }, 1)).toMatchObject({ strong: 1 });
    expect(rumbleFor({ type: "ko", player: 1 }, 1)!.duration).toBeGreaterThan(300);
    expect(rumbleFor({ type: "ko", player: 1 }, 0)).toBeNull();
    expect(rumbleFor({ type: "fight" }, 0)).toBeNull();
  });

  it("uses the standard dual-rumble effect, or Firefox's pulse, and ignores pads without haptics", () => {
    const calls: unknown[] = [];
    playRumble({ vibrationActuator: { playEffect: async (type, params) => calls.push([type, params]) } }, { duration: 120, strong: 0.2, weak: 0.5 });
    expect(calls).toEqual([["dual-rumble", { startDelay: 0, duration: 120, strongMagnitude: 0.2, weakMagnitude: 0.5 }]]);
    const pulses: unknown[] = [];
    playRumble({ hapticActuators: [{ pulse: async (v, d) => pulses.push([v, d]) }] }, { duration: 120, strong: 0.2, weak: 0.5 });
    expect(pulses).toEqual([[0.5, 120]]);
    expect(() => playRumble({}, { duration: 1, strong: 1, weak: 1 })).not.toThrow();
    expect(() => playRumble(null, { duration: 1, strong: 1, weak: 1 })).not.toThrow();
  });

  it("very short or soft effects are lifted to what pads can produce", () => {
    expect(perceptible({ duration: 45, strong: 0, weak: 0.2 })).toEqual({ duration: 100, strong: 0, weak: 0.45 });
    const heavy = { duration: 200, strong: 1, weak: 0.6 };
    expect(perceptible(heavy)).toEqual(heavy);
  });

  it("gamepad sources rumble the live browser pad, not the snapshot Phaser kept", () => {
    const stale: unknown[] = [];
    const live: unknown[] = [];
    const plugin = { getPad: () => ({ ...fakePad(), pad: { vibrationActuator: { playEffect: async (...a: unknown[]) => stale.push(a) } } }) } as never;
    const nav = globalThis.navigator as unknown as { getGamepads?: () => unknown[] };
    const original = nav.getGamepads;
    nav.getGamepads = () => [null, { vibrationActuator: { playEffect: async (...a: unknown[]) => live.push(a) } }];
    try {
      const src = new GamepadInputSource(plugin, 1);
      src.rumble({ duration: 100, strong: 0.5, weak: 0.5 });
      src.rumble({ duration: 100, strong: 0.5, weak: 0.5 });
    } finally {
      nav.getGamepads = original;
    }
    expect(live).toHaveLength(2);
    expect(stale).toHaveLength(0);
  });
});
