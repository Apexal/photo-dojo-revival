import {
  ATTACKS,
  JUMP_SQUAT_FRAMES,
  KNOCKDOWN,
  TAUNT,
  THROW_LENIENCY_FRAMES,
  THROW_TOTAL_FRAMES,
  attackPhaseAt,
  attackTotalFrames,
  type AttackId,
  type FighterAction,
} from "../shared/frame-data";
import type { Facing } from "./collision";
import type { InputFrame } from "./input-frame";

export const STAGE_WIDTH = 1280;
export const STAGE_MARGIN = 60;
export const FLOOR_Y = 0;
export const GRAVITY = 0.6;
export const JUMP_IMPULSE = -14;
export const WALK_SPEED = 4;
export const BLOCK_DAMAGE_FRACTION = 0.25;
export const HITSTOP_FRAMES = 6;

export interface FighterState {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  facing: Facing;
  health: number;
  action: FighterAction;
  actionFrame: number;      // frames elapsed in current action
  hitstopFrames: number;
  /** Length of the current hurt or blockstun (a blocked hit locks the fighter in block this long). */
  stunFrames: number;
  /** The current attack already connected; one hit per attack. */
  hasHit: boolean;
  /** Which captured version of the action's pose to show (0 = main); chosen by the simulation. */
  variant: number;
  /** Holding down: a crouching guard stops lows but not overheads. */
  crouching: boolean;
  /** One air attack per jump. */
  airAttackUsed: boolean;
  /** The current attack was pressed while holding back: kicks come out in place instead of lunging. */
  retreating: boolean;
}

/** Punch/kick presses this frame, including ones still held in the input buffer. */
export interface Presses { punch: boolean; kick: boolean }

export interface StepContext {
  /** Held directions (and buttons). */
  input: InputFrame;
  /** Buffered button presses; the simulation clears them when they start a move. */
  pressed: Presses;
  opponent: FighterState;
  /** False during round intro/outro: no new actions from input. */
  controllable: boolean;
}

export function createFighterState(x: number, facing: Facing, health: number): FighterState {
  return {
    position: { x, y: FLOOR_Y },
    velocity: { x: 0, y: 0 },
    facing,
    health,
    action: "idle",
    actionFrame: 0,
    hitstopFrames: 0,
    stunFrames: 0,
    hasHit: false,
    variant: 0,
    crouching: false,
    airAttackUsed: false,
    retreating: false,
  };
}

export const isGrounded = (s: FighterState) => s.position.y >= FLOOR_Y && s.velocity.y >= 0;
export const isAttack = (a: FighterAction): a is AttackId =>
  a === "punch" || a === "kick" || a === "uppercut" || a === "lowKick" || a === "jumpKick";
/** Moves the fighter can't interrupt: attacks, throws and taunts. */
export const isCommitted = (a: FighterAction) => isAttack(a) || a === "throw" || a === "taunt";
/** Holding a guard: free block or locked blockstun. */
export const isGuarding = (s: FighterState) => s.action === "block" || s.action === "blockstun";
/** Knocked down: flying, lying on the floor, or getting up. */
export const isDown = (s: FighterState) => s.action === "knockdown" || s.action === "downed" || s.action === "wakeup";
/** Can't be hit or thrown, and has no push box: knocked down, or KO'd. */
export const isUntouchable = (s: FighterState) => isDown(s) || s.action === "ko";
/** Guarding low on the ground: shown with the crouch capture, and high attacks pass over it. */
export const isCrouching = (s: FighterState) => isGuarding(s) && s.crouching && isGrounded(s);

export function currentAttackPhase(s: FighterState) {
  return isAttack(s.action) ? attackPhaseAt(ATTACKS[s.action], s.actionFrame) : null;
}

/** An opponent attack that hasn't finished its active frames makes holding back a block. */
export function isThreatening(s: FighterState): boolean {
  const phase = currentAttackPhase(s);
  return phase === "startup" || phase === "active";
}

function setAction(s: FighterState, action: FighterAction): FighterState {
  if (s.action === action) return { ...s, actionFrame: s.actionFrame + 1 };
  return { ...s, action, actionFrame: 0, hasHit: false };
}

function faceOpponent(s: FighterState, opponent: FighterState): FighterState {
  if (opponent.position.x === s.position.x) return s;
  return { ...s, facing: opponent.position.x > s.position.x ? 1 : -1 };
}

export function clampToStage(x: number): number {
  return Math.min(STAGE_WIDTH - STAGE_MARGIN, Math.max(STAGE_MARGIN, x));
}

function applyPhysics(s: FighterState): FighterState {
  let { x, y } = s.position;
  let { x: vx, y: vy } = s.velocity;
  const airborne = y < FLOOR_Y || vy < 0;
  if (airborne) vy += GRAVITY;
  x = clampToStage(x + vx);
  y += vy;
  let next: FighterState = { ...s, position: { x, y }, velocity: { x: vx, y: vy } };
  if (y >= FLOOR_Y && airborne) {
    next = { ...next, position: { x, y: FLOOR_Y }, velocity: { x: 0, y: 0 }, airAttackUsed: false };
    // Landing ends a jump, and cancels whatever is left of a jump kick.
    if (next.action === "jump" || next.action === "jumpKick") next = { ...next, action: "idle", actionFrame: 0, hasHit: false };
  }
  return next;
}

/** Frames from leaving the floor with vertical speed `vy` (negative: up) to landing again. */
export function airFrames(vy: number): number {
  let y = FLOOR_Y, v = vy, frames = 0;
  do {
    v += GRAVITY;
    y += v;
    frames++;
  } while (y < FLOOR_Y && frames < 1000);
  return frames;
}

/**
 * Knock a fighter down: launched `away` (1 right, -1 left) and up, they fly
 * until they land, lie on the floor, then get up (stepFighter). `vx` overrides
 * the sideways speed (a throw aims for where they land).
 */
export function knockDown(s: FighterState, away: 1 | -1, vx: number = away * KNOCKDOWN.launch.x): FighterState {
  return {
    ...s, action: "knockdown", actionFrame: 0, stunFrames: 0, hasHit: false, crouching: false, retreating: false,
    velocity: { x: vx, y: KNOCKDOWN.launch.y },
  };
}

const startMove = (s: FighterState, action: FighterAction): FighterState =>
  ({ ...s, action, actionFrame: 0, hasHit: false, stunFrames: 0, velocity: { x: 0, y: 0 }, retreating: false });

/**
 * Choose the grounded action for this frame from input.
 * Punch + kick together = throw; down + punch = uppercut; down + kick = low kick.
 */
function chooseFreeAction(s: FighterState, ctx: StepContext): FighterState {
  const { input, pressed, opponent } = ctx;
  const forwardHeld = s.facing === 1 ? input.right : input.left;
  const backHeld = s.facing === 1 ? input.left : input.right;

  if (pressed.punch && pressed.kick) {
    return startMove(s, Math.abs(opponent.position.x - s.position.x) >= TAUNT.minDistance ? "taunt" : "throw");
  }
  if (pressed.punch) return startMove(s, input.down ? "uppercut" : "punch");
  // Kicking while backing off keeps your distance: no lunge.
  if (pressed.kick) return { ...startMove(s, input.down ? "lowKick" : "kick"), retreating: backHeld };
  if (input.up) return { ...startMove(s, "jumpSquat"), crouching: false };
  if (input.down || (backHeld && isThreatening(opponent))) return { ...setAction(s, "block"), crouching: input.down, velocity: { x: 0, y: 0 } };
  if (forwardHeld !== backHeld) {
    return { ...setAction(s, "walk"), crouching: false, velocity: { x: (forwardHeld ? 1 : -1) * s.facing * WALK_SPEED, y: 0 } };
  }
  return { ...setAction(s, "idle"), crouching: false, velocity: { x: 0, y: 0 } };
}

/** Free to act (idle / walk / block): face the opponent and pick an action from input. */
function actFree(s: FighterState, ctx: StepContext): FighterState {
  const faced = faceOpponent(s, ctx.opponent);
  return ctx.controllable ? chooseFreeAction(faced, ctx) : { ...setAction(faced, "idle"), velocity: { x: 0, y: 0 } };
}

/** A locked action just ended: the fighter acts on this same frame, so buffered presses come out on the first free frame. */
function recover(s: FighterState, ctx: StepContext, into: FighterAction = "idle"): FighterState {
  const reset = { ...s, actionFrame: 0, hasHit: false, stunFrames: 0 };
  // Recovering in mid-air: just fall (no air actions, no second jump).
  if (!isGrounded(s)) return { ...reset, action: "jump", airAttackUsed: true };
  return actFree({ ...reset, action: into }, ctx);
}

/** One frame of a single fighter: action timers, input, physics. Hits are resolved by the simulation afterwards. */
export function stepFighter(s: FighterState, ctx: StepContext): FighterState {
  let next: FighterState;
  switch (s.action) {
    case "ko":
    case "win":
      next = { ...s, actionFrame: s.actionFrame + 1, velocity: { x: isGrounded(s) ? 0 : s.velocity.x, y: s.velocity.y } };
      break;
    case "knockdown":
      // Flying: physics carries them; landing puts them on the floor.
      next = isGrounded(s) && s.actionFrame > 0
        ? { ...s, action: "downed", actionFrame: 0, velocity: { x: 0, y: 0 } }
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "downed":
      next = s.actionFrame + 1 >= KNOCKDOWN.floorFrames
        ? { ...s, action: "wakeup", actionFrame: 0, velocity: { x: 0, y: 0 } }
        : { ...s, actionFrame: s.actionFrame + 1, velocity: { x: 0, y: 0 } };
      break;
    case "wakeup":
      next = s.actionFrame + 1 >= KNOCKDOWN.wakeFrames
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1, velocity: { x: 0, y: 0 } };
      break;
    case "blockstun":
      // Locked in guard after a blocked hit; ends exactly like hitstun does.
      next = s.actionFrame + 1 >= s.stunFrames
        ? recover(s, ctx, "block")
        : { ...s, actionFrame: s.actionFrame + 1, velocity: { x: 0, y: 0 } };
      break;
    case "hurt":
      next = s.actionFrame + 1 >= s.stunFrames
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "jumpSquat": {
      // The wind-up can still turn into a block.
      const backHeld = s.facing === 1 ? ctx.input.left : ctx.input.right;
      if (ctx.controllable && (ctx.input.down || (backHeld && isThreatening(ctx.opponent)))) {
        next = { ...s, action: "block", actionFrame: 0, crouching: ctx.input.down, velocity: { x: 0, y: 0 } };
      } else if (s.actionFrame + 1 >= JUMP_SQUAT_FRAMES) {
        const dir = ctx.input.right === ctx.input.left ? 0 : ctx.input.right ? 1 : -1;
        next = { ...s, action: "jump", actionFrame: 0, airAttackUsed: false, velocity: { x: dir * WALK_SPEED, y: JUMP_IMPULSE } };
      } else {
        next = { ...s, actionFrame: s.actionFrame + 1 };
      }
      break;
    }
    case "taunt":
      next = s.actionFrame + 1 >= TAUNT.frames ? recover(s, ctx) : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "jumpKick":
      // Recovery runs out in the air: keep falling (no second air attack); landing ends it early.
      next = s.actionFrame + 1 >= attackTotalFrames(ATTACKS.jumpKick)
        ? { ...s, action: "jump", actionFrame: 0, hasHit: false }
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "punch":
    case "kick":
    case "uppercut":
    case "lowKick": {
      // Leniency: pressing the other button just after starting an attack makes it a throw.
      const other = s.action === "punch" || s.action === "uppercut" ? ctx.pressed.kick : ctx.pressed.punch;
      if (ctx.controllable && other && s.actionFrame < THROW_LENIENCY_FRAMES) {
        next = startMove(s, "throw");
        break;
      }
      const attack = ATTACKS[s.action];
      next = s.actionFrame + 1 >= attackTotalFrames(attack)
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      // Lunge (kicks): move forward evenly over the active frames, so the body only
      // closes in once the kick is already out. Contact (hit or block) stops it, so
      // the pushback holds and a kick blocked at the tip of its range is safe.
      if (next.action === s.action) {
        const f = next.actionFrame;
        const lunging = attack.advance && !s.retreating && !s.hasHit && f >= attack.startup && f < attack.startup + attack.active;
        next = { ...next, velocity: { x: lunging ? (s.facing * attack.advance!) / attack.active : 0, y: 0 } };
      }
      break;
    }
    case "throw":
      next = s.actionFrame + 1 >= THROW_TOTAL_FRAMES
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "grabbed":
      // Held in place; the simulation decides between a tech and the throw landing.
      next = { ...s, actionFrame: s.actionFrame + 1, velocity: { x: 0, y: 0 } };
      break;
    case "jump":
      next = ctx.controllable && ctx.pressed.kick && !s.airAttackUsed && !isGrounded(s)
        ? { ...s, action: "jumpKick", actionFrame: 0, hasHit: false, airAttackUsed: true }
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    default:
      // idle / walk / block: free to act while grounded.
      next = actFree(s, ctx);
  }
  return applyPhysics(next);
}

/** Damage after blocking; blocked hits take 25%. */
export function blockedDamage(damage: number): number {
  return Math.round(damage * BLOCK_DAMAGE_FRACTION);
}

/** `minHealth` 1 = practice mode: nobody gets KO'd. */
export function applyHit(defender: FighterState, attack: AttackId, blocked: boolean, minHealth = 0): FighterState {
  const data = ATTACKS[attack];
  const damage = blocked ? blockedDamage(data.damage) : data.damage;
  // Chip damage from a blocked hit never finishes a round: blocking shouldn't feel like losing.
  const health = Math.max(blocked ? Math.max(1, minHealth) : minHealth, defender.health - damage);
  if (health <= 0) return { ...defender, health, action: "ko", actionFrame: 0, stunFrames: 0, velocity: { x: 0, y: defender.velocity.y } };
  // Blockstun: locked in block, no hitstun.
  if (blocked) return { ...defender, health, action: "blockstun", actionFrame: 0, stunFrames: data.blockstun, velocity: { x: 0, y: defender.velocity.y } };
  return { ...defender, health, action: "hurt", actionFrame: 0, stunFrames: data.hitstun, velocity: { x: 0, y: defender.velocity.y } };
}

/** Can be grabbed: grounded and neutral. Attacks beat throws; no throwing someone in hit- or blockstun. */
export function isThrowable(s: FighterState): boolean {
  if (!isGrounded(s)) return false;
  return s.action === "idle" || s.action === "walk" || s.action === "block" || s.action === "taunt" || s.action === "jumpSquat";
}
