import type { FightEvent } from "../../simulation/fight-simulation";
import type { PlayerIndex } from "../../simulation/round-rules";

/** One rumble: duration in ms, motor strengths 0..1 (strong = low-frequency, weak = high-frequency). */
export interface Rumble { duration: number; strong: number; weak: number }

const HEAVY_ATTACKS = new Set(["kick", "lowKick", "jumpKick", "uppercut", "charge", "flyingKnee"]);

/**
 * What a fight event feels like on each player's controller (null: nothing).
 * Tuned for Xbox-style pads, where the big low-frequency motor ("strong") is
 * what you actually feel; the small one adds buzz. Getting hit > landing a hit > blocking.
 */
export function rumbleFor(event: FightEvent, player: PlayerIndex): Rumble | null {
  switch (event.type) {
    case "hit": {
      const heavy = HEAVY_ATTACKS.has(event.attack);
      if (event.defender === player) {
        if (event.blocked) return { duration: 100, strong: 0.25, weak: 0.5 };
        return heavy ? { duration: 180, strong: 0.85, weak: 0.5 } : { duration: 120, strong: 0.5, weak: 0.6 };
      }
      if (event.attacker === player && !event.blocked) return { duration: 100, strong: heavy ? 0.4 : 0.3, weak: 0.45 };
      return null;
    }
    case "parry":
      return event.player === player ? { duration: 90, strong: 0.2, weak: 0.7 } : { duration: 160, strong: 0.6, weak: 0.3 };
    case "grab":
      return { duration: 100, strong: 0.35, weak: 0.4 };
    case "throw":
      return event.defender === player ? { duration: 260, strong: 1, weak: 0.7 } : { duration: 120, strong: 0.45, weak: 0.4 };
    case "throwTech":
      return { duration: 100, strong: 0.3, weak: 0.5 };
    case "ko":
      return event.player === player ? { duration: 500, strong: 1, weak: 0.9 } : null;
    default:
      return null;
  }
}

/** How hard an effect feels, for picking between effects. */
export const intensity = (r: Rumble) => Math.max(r.strong, r.weak * 0.6) * Math.sqrt(r.duration);

/**
 * One controller's rumble queue. Effects requested in the same frame collapse
 * into the strongest; a weaker effect doesn't cut off a stronger one that's
 * still playing (a new effect always replaces the running one on the pad).
 */
export class RumbleScheduler {
  private pending: Rumble | null = null;
  private playing: { until: number; intensity: number } | null = null;

  request(r: Rumble): void {
    if (!this.pending || intensity(r) > intensity(this.pending)) this.pending = r;
  }

  /** Call once per frame; returns the effect to play now, if any. */
  flush(now: number): Rumble | null {
    const r = this.pending;
    this.pending = null;
    if (!r) return null;
    if (this.playing && now < this.playing.until && intensity(r) <= this.playing.intensity) return null;
    this.playing = { until: now + r.duration, intensity: intensity(r) };
    return r;
  }
}

/** Shorter or softer effects than this don't register on some pads (e.g. PlayStation controllers over Bluetooth). */
export const MIN_RUMBLE_MS = 100;
export const MIN_RUMBLE_MAGNITUDE = 0.45;

/** Lift an effect to what pads can actually produce, keeping its shape. */
export function perceptible(r: Rumble): Rumble {
  const peak = Math.max(r.strong, r.weak);
  const lift = peak > 0 && peak < MIN_RUMBLE_MAGNITUDE ? MIN_RUMBLE_MAGNITUDE / peak : 1;
  return { duration: Math.max(MIN_RUMBLE_MS, r.duration), strong: Math.min(1, r.strong * lift), weak: Math.min(1, r.weak * lift) };
}

/** Confirmation buzz when a pad joins on fighter select. */
export const JOIN_RUMBLE: Rumble = { duration: 150, strong: 0.45, weak: 0.6 };

interface HapticGamepad {
  vibrationActuator?: { playEffect?: (type: "dual-rumble", params: Record<string, number>) => Promise<unknown> } | null;
  hapticActuators?: readonly { pulse?: (value: number, duration: number) => Promise<unknown> }[];
}

/**
 * Plays a rumble on a browser Gamepad: the standard dual-rumble effect (Chrome,
 * Edge, Safari) or Firefox's single-motor pulse. Pads without haptics ignore it.
 */
export function playRumble(pad: HapticGamepad | null | undefined, effect: Rumble): void {
  if (!pad) return;
  const r = perceptible(effect);
  // Logged so a misbehaving pad can be diagnosed from the console: "complete" = played in full,
  // "preempted" = replaced by a newer effect, an error = the browser refused it.
  const log = (result: unknown) => console.debug(`[rumble] ${r.duration}ms strong=${r.strong.toFixed(2)} weak=${r.weak.toFixed(2)} →`, result);
  const actuator = pad.vibrationActuator;
  if (actuator?.playEffect) {
    actuator.playEffect("dual-rumble", { startDelay: 0, duration: r.duration, strongMagnitude: r.strong, weakMagnitude: r.weak }).then(log, log);
    return;
  }
  if (pad.hapticActuators?.[0]?.pulse) {
    pad.hapticActuators[0].pulse(Math.max(r.strong, r.weak), r.duration).then(log, log);
    return;
  }
  console.debug("[rumble] this controller/browser has no haptics");
}
