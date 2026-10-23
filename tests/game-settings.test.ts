import { afterEach, describe, expect, it } from "vitest";
import { MOVE_GUIDE, controlLabels } from "../src/game/input/control-labels";
import {
  DEFAULT_KEY_BINDINGS,
  KEY,
  RemapSession,
  isDefaultBindings,
  isKeyBindings,
  keyBindings,
  keyLabel,
  layoutForKey,
  setKeyBindings,
} from "../src/game/input/key-bindings";
import { CLOCK_WARNING_SECONDS, LOW_HEALTH, clockCue, clockTicked, lowHealthPulse } from "../src/game/render/hud-cues";
import { formatCountdown } from "../src/shared/room-code";
import { ROUND_FRAMES, createMatch, type RoundState } from "../src/simulation/round-rules";

afterEach(() => setKeyBindings(DEFAULT_KEY_BINDINGS));

describe("key remapping", () => {
  const press = (session: RemapSession, ...codes: number[]) => codes.map((c) => session.press(c));

  it("assigns one key per action, in order, and replaces only that keyboard half", () => {
    const s = new RemapSession("p1");
    expect(s.action).toBe("left");
    expect(press(s, 70, 72, 84, 71, 85, 73)).toEqual([null, null, null, null, null, null]); // F H T G U I
    expect(s.done).toBe(true);
    const b = s.result();
    expect(b.p1).toEqual({ left: [70], right: [72], up: [84], down: [71], punch: [85], kick: [73] });
    expect(b.p2).toEqual(DEFAULT_KEY_BINDINGS.p2);
  });

  it("refuses keys the other half uses, keys already assigned in this pass, and reserved keys", () => {
    const s = new RemapSession("p1");
    expect(s.press(KEY.LEFT)).toBe("← is P2's left");
    expect(s.press(KEY.ESC)).toMatch(/reserved/);
    expect(s.press(KEY.F1)).toMatch(/reserved/);
    expect(s.press(49)).toMatch(/reserved/); // 1: practice dummy picker
    expect(s.press(KEY.A)).toBeNull();
    expect(s.press(KEY.A)).toBe("A is already left");
    expect(s.action).toBe("right");
  });

  it("can reuse its own old keys in a new order (swap punch and kick)", () => {
    const s = new RemapSession("p1");
    press(s, KEY.A, KEY.D, KEY.W, KEY.S, KEY.K, KEY.J);
    expect(s.result().p1).toMatchObject({ punch: [KEY.K], kick: [KEY.J] });
  });

  it("joining, labels and the move guide follow the current bindings", () => {
    const s = new RemapSession("p2");
    press(s, 100, 102, 104, 101, 96, 110); // numpad 4 6 8 5 0 .
    setKeyBindings(s.result());
    expect(layoutForKey(104)).toBe("p2");
    expect(layoutForKey(KEY.LEFT)).toBeNull();
    const l = controlLabels({ kind: "keyboard", layout: "p2" }, "right");
    expect(MOVE_GUIDE.find((m) => m.name === "Throw")!.how(l)).toBe("Num0 + Num.");
    expect(MOVE_GUIDE.find((m) => m.name === "Walk")!.how(l)).toBe("Num6 / Num4");
    expect(isDefaultBindings(keyBindings())).toBe(false);
  });

  it("validates stored bindings before using them", () => {
    expect(isKeyBindings(DEFAULT_KEY_BINDINGS)).toBe(true);
    expect(isKeyBindings(null)).toBe(false);
    expect(isKeyBindings({ p1: DEFAULT_KEY_BINDINGS.p1 })).toBe(false);
    expect(isKeyBindings({ ...DEFAULT_KEY_BINDINGS, p2: { ...DEFAULT_KEY_BINDINGS.p2, kick: [] } })).toBe(false);
  });

  it("names keys readably", () => {
    expect([keyLabel(KEY.J), keyLabel(KEY.UP), keyLabel(KEY.COMMA), keyLabel(KEY.SPACE), keyLabel(97), keyLabel(113)]).toEqual(["J", "↑", ",", "Space", "Num1", "F2"]);
  });
});

describe("HUD cues", () => {
  const fighting = (framesRemaining: number): RoundState => ({ ...createMatch(), phase: "fighting", framesRemaining });

  it("the health bar pulses only when low, and faster when very low", () => {
    expect(lowHealthPulse(LOW_HEALTH + 1, 20)).toBe(0);
    expect(lowHealthPulse(0, 20)).toBe(0);
    const values = (h: number, period: number) => Array.from({ length: period }, (_, f) => lowHealthPulse(h, f));
    expect(Math.max(...values(LOW_HEALTH, 40))).toBeCloseTo(1, 1);
    expect(lowHealthPulse(LOW_HEALTH, 0)).toBe(0);
    expect(lowHealthPulse(5, 12)).toBeCloseTo(1); // half of the 24-frame period
  });

  it("the clock flashes only in the last 10 seconds of a live round", () => {
    expect(clockCue(fighting(ROUND_FRAMES)).warning).toBe(false);
    expect(clockCue(fighting(CLOCK_WARNING_SECONDS * 60 + 1)).warning).toBe(false);
    expect(clockCue(fighting(CLOCK_WARNING_SECONDS * 60)).warning).toBe(true);
    expect(clockCue({ ...fighting(120), phase: "outro" }).warning).toBe(false);
  });

  it("pops and turns red right as the second changes", () => {
    const justTicked = clockCue(fighting(540)); // shows 9
    const aboutTo = clockCue(fighting(541)); // still shows 10
    expect(justTicked).toMatchObject({ red: true });
    expect(justTicked.scale).toBeGreaterThan(1.2);
    expect(aboutTo).toMatchObject({ red: false });
    expect(aboutTo.scale).toBeCloseTo(1, 2);
  });

  it("ticks once per second from 10 down to 1", () => {
    let ticks = 0;
    for (let f = 700; f > 0; f--) if (clockTicked(fighting(f), fighting(f - 1))) ticks++;
    expect(ticks).toBe(10);
  });
});

describe("room code countdown", () => {
  it("shows minutes and seconds, rounded up", () => {
    expect(formatCountdown(192_000)).toBe("3:12");
    expect(formatCountdown(191_001)).toBe("3:12");
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(500)).toBe("0:01");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
