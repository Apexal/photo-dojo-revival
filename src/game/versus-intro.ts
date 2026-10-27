import { ARCHETYPES, type ArchetypeId } from "../shared/archetypes";
import { ATTACKS, GRABS, PARRY_TOTAL_FRAMES, TAUNT, grabTotalFrames, isGrab, type FighterAction } from "../shared/frame-data";
import { isAttack } from "../simulation/fighter-state-machine";

/*
 * The versus intro's show-off: each fighter runs through their moves in place
 * (real frame data, so it looks like the fight), holds their victory pose,
 * and goes round again for as long as the intro lasts.
 * Pure, so it's Node-tested; VersusScene renders it.
 */

export interface RoutineStep { action: FighterAction; frames: number }

/** A move's full length: startup, active and recovery. */
export function moveFrames(action: FighterAction): number {
  if (isAttack(action)) return ATTACKS[action].startup + ATTACKS[action].active + ATTACKS[action].recovery;
  if (isGrab(action)) return grabTotalFrames(GRABS[action]);
  if (action === "parry") return PARRY_TOTAL_FRAMES;
  if (action === "taunt") return TAUNT.frames;
  return 1;
}

/** The taunt freezes this far in: the victory pose, before it eases back to the stance. */
export const POSE_HOLD_FRAME = Math.floor(TAUNT.frames / 2);
/** How long the victory pose is held before the routine starts over. */
export const VICTORY_HOLD_FRAMES = 110;

/** Punch, kick, uppercut, the archetype's signature move, then the victory pose (the last step). */
export function showOffRoutine(archetype: ArchetypeId): RoutineStep[] {
  const move = (action: FighterAction): RoutineStep => ({ action, frames: moveFrames(action) });
  const beat = (frames: number): RoutineStep => ({ action: "idle", frames });
  return [
    beat(16), move("punch"), beat(8), move("kick"), beat(8), move("uppercut"), beat(14),
    move(ARCHETYPES[archetype].move), beat(14), { action: "taunt", frames: VICTORY_HOLD_FRAMES },
  ];
}

/** Frames before the victory pose (the first time round). */
export const routineLength = (routine: readonly RoutineStep[]) =>
  routine.slice(0, -1).reduce((sum, step) => sum + step.frames, 0);

/** One time round, victory pose included. */
export const cycleLength = (routine: readonly RoutineStep[]) => routine.reduce((sum, step) => sum + step.frames, 0);

/**
 * What a fighter is doing `frame` frames into their routine, which repeats.
 * Before it starts (negative frames) they stand ready; the victory pose holds
 * at POSE_HOLD_FRAME.
 */
export function routineAt(routine: readonly RoutineStep[], frame: number): { action: FighterAction; actionFrame: number; step: number } {
  if (frame < 0) return { action: "idle", actionFrame: 0, step: -1 };
  let f = frame % cycleLength(routine);
  for (let i = 0; i < routine.length; i++) {
    const step = routine[i];
    if (f < step.frames) {
      const actionFrame = step.action === "taunt" ? Math.min(f, POSE_HOLD_FRAME) : f;
      return { action: step.action, actionFrame, step: i };
    }
    f -= step.frames;
  }
  // Unreachable: f is within one cycle.
  return { action: "taunt", actionFrame: POSE_HOLD_FRAME, step: routine.length - 1 };
}

/** The frame (into the routine) the signature move starts on: the fighter's battle cry. */
export function signatureStartFrame(routine: readonly RoutineStep[], archetype: ArchetypeId): number {
  const move = ARCHETYPES[archetype].move;
  let f = 0;
  for (const step of routine) {
    if (step.action === move) return f;
    f += step.frames;
  }
  return -1;
}
