import { GRABS } from "../shared/frame-data";
import type { FightEvent } from "../simulation/fight-simulation";
import type { PlayerIndex } from "../simulation/round-rules";
import type { ButtonLabels } from "./input/control-labels";

/** Tips show in a fighter's first matches (career record), as well as in practice and the tutorial. */
export const TIP_MATCHES = 3;

/** Whether a player gets tips: practice (only the player, not the dummy), or a person on a fighter with fewer than TIP_MATCHES finished matches. */
export function showsTips(o: { practice: boolean; player: PlayerIndex; isPerson: boolean; matchesPlayed: number }): boolean {
  if (!o.isPerson) return false;
  return o.practice ? o.player === 0 : o.matchesPlayed < TIP_MATCHES;
}

export interface FightTip {
  /** Who it's for: the one who got caught. */
  player: PlayerIndex;
  text: string;
}

/**
 * What to tell the player who just got caught out, with their own buttons
 * (`labels` for the defender's device and side): a low past a standing guard,
 * an overhead past a crouching one, a grab that can still be broken.
 */
export function tipFor(ev: FightEvent, labels: (player: PlayerIndex) => ButtonLabels): FightTip | null {
  if (ev.type === "hit" && ev.wrongGuard) {
    const b = labels(ev.defender);
    return {
      player: ev.defender,
      text: ev.wrongGuard === "low" ? `LOW! Block it crouching (${b.down})` : `OVERHEAD! Block it standing (${b.back})`,
    };
  }
  if (ev.type === "grab" && GRABS[ev.grab].techable) {
    return { player: ev.defender, text: `GRABBED! ${labels(ev.defender).throw} breaks free` };
  }
  return null;
}
