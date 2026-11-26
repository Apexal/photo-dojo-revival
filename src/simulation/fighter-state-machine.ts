import { ARCHETYPES, type ArchetypeId } from "../shared/archetypes";
import {
  ATTACKS,
  DASH,
  GRABS,
  GUARD_BREAK,
  JUMP_SQUAT_FRAMES,
  KNOCKDOWN,
  PARRY_TOTAL_FRAMES,
  TAUNT,
  THROW_LENIENCY_FRAMES,
  attackPhaseAt,
  attackTotalFrames,
  grabTotalFrames,
  isAttackId,
  isGrab,
  type AttackId,
  type FighterAction,
  type GrabId,
} from "../shared/frame-data";
import type { Facing } from "./collision";
import type { InputFrame } from "./input-frame";

export const STAGE_WIDTH = 1280;
export const STAGE_MARGIN = 60;
export const FLOOR_Y = 0;
/** Gravity on everything that flies except a jump: knockdowns, throws, a KO'd fighter. */
export const GRAVITY = 0.6;
/** A jump falls faster than a knockdown, so it's quick (40 frames in the air) without being lower. */
export const JUMP_GRAVITY = 0.8;
export const JUMP_IMPULSE = -16;
/** Sideways speed of a jump with a direction held: about the distance a 4 px/frame jump used to cover. */
export const JUMP_SPEED_X = 4.5;
/** Walking forward is quicker than backing off: coming in should feel fast, running away should cost something. */
export const WALK_FORWARD_SPEED = 5.5;
export const WALK_BACK_SPEED = 4.5;
/** Of a walking fighter's speed, how much carries through the startup of an attack pressed mid-stride. */
export const ATTACK_CARRY = 0.5;
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
  /** While "grabbed": which grab is holding them (it decides the damage, the distance and whether it can be broken). */
  grabbedBy: GrabId;
  /** Blocked hits in a row (GUARD_BREAK): the guard breaks at GUARD_BREAK.blocks. */
  guardHits: number;
  /** Frames left before guardHits starts over (since the last blocked hit). */
  guardWindow: number;
  /** Frames left of a broken guard: no blocking until it runs out. */
  guardBrokenFrames: number;
}

/** Button presses this frame (punch, kick and a controller's uppercut and taunt buttons), including ones still held in the input buffer. */
export interface Presses { punch: boolean; kick: boolean; uppercut: boolean; taunt: boolean }

export const PRESS_BUTTONS = ["punch", "kick", "uppercut", "taunt"] as const satisfies readonly (keyof Presses)[];

export interface StepContext {
  /** Held directions (and buttons). */
  input: InputFrame;
  /** Buffered button presses; the simulation clears them when they start a move. */
  pressed: Presses;
  opponent: FighterState;
  /** False during round intro/outro: no new actions from input. */
  controllable: boolean;
  /** Whose signature move down + punch + kick starts. */
  archetype: ArchetypeId;
  /**
   * The opponent's attack is coming and could reach this fighter (isThreatening
   * plus range, worked out by the simulation from hitboxes): holding back blocks
   * instead of walking away. Out of range, backing off just walks.
   */
  threatened: boolean;
  /** A buffered double tap (DASH): the way it goes on screen (1 right, -1 left), or 0. */
  dash?: -1 | 0 | 1;
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
    grabbedBy: "throw",
    guardHits: 0,
    guardWindow: 0,
    guardBrokenFrames: 0,
  };
}

export const isGrounded = (s: FighterState) => s.position.y >= FLOOR_Y && s.velocity.y >= 0;
export const isAttack = isAttackId;
/** Moves the fighter can't interrupt: attacks, grabs, the parry and taunts. */
export const isCommitted = (a: FighterAction) => isAttack(a) || isGrab(a) || a === "parry" || a === "taunt";
/** A forward or back dash (DASH): committed too, but presses made during it are kept for when it ends. */
export const isDash = (a: FighterAction): a is "dash" | "backdash" => a === "dash" || a === "backdash";
/** Not able to guard: the guard was broken a moment ago (GUARD_BREAK.lockout). */
export const isGuardBroken = (s: FighterState) => s.guardBrokenFrames > 0;
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

/** A jump (and an attack or a hit taken during one) falls with JUMP_GRAVITY; anything flung falls with GRAVITY. */
function isJumping(s: FighterState): boolean {
  return s.action !== "knockdown" && s.action !== "ko";
}

function applyPhysics(s: FighterState): FighterState {
  let { x, y } = s.position;
  let { x: vx, y: vy } = s.velocity;
  const airborne = y < FLOOR_Y || vy < 0;
  if (airborne) vy += isJumping(s) ? JUMP_GRAVITY : GRAVITY;
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
export function airFrames(vy: number, gravity = GRAVITY): number {
  let y = FLOOR_Y, v = vy, frames = 0;
  do {
    v += gravity;
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

/** An attack pressed mid-stride keeps some of the walk's speed through its startup (stepFighter), so walking in and swinging is one motion. */
function startAttack(s: FighterState, action: FighterAction): FighterState {
  const started = startMove(s, action);
  return s.action === "walk" ? { ...started, velocity: { x: s.velocity.x * ATTACK_CARRY, y: 0 } } : started;
}

/**
 * Punch + kick: with down held, the archetype's signature; otherwise a throw
 * (or a taunt from far away, on a device without a taunt button, unless it
 * came from a throw button: that always throws).
 */
function bothButtons(s: FighterState, ctx: StepContext): FighterAction {
  if (ctx.input.down) return ARCHETYPES[ctx.archetype].move;
  if (ctx.input.hasTauntButton || ctx.input.throw) return "throw";
  return Math.abs(ctx.opponent.position.x - s.position.x) >= TAUNT.minDistance ? "taunt" : "throw";
}

/**
 * Choose the grounded action for this frame from input.
 * Punch + kick together = throw, or with down the signature; down + punch (or the uppercut button) = uppercut;
 * down + kick = low kick; the taunt button = taunt.
 */
function chooseFreeAction(s: FighterState, ctx: StepContext): FighterState {
  const { input, pressed } = ctx;
  const forwardHeld = s.facing === 1 ? input.right : input.left;
  const backHeld = s.facing === 1 ? input.left : input.right;
  const canGuard = !isGuardBroken(s);

  if (pressed.punch && pressed.kick) return startMove(s, bothButtons(s, ctx));
  if (pressed.uppercut) return startAttack(s, "uppercut");
  if (pressed.punch) return startAttack(s, input.down ? "uppercut" : "punch");
  // Kicking while backing off keeps your distance: no lunge.
  if (pressed.kick) return { ...startAttack(s, input.down ? "lowKick" : "kick"), retreating: backHeld };
  if (pressed.taunt) return startMove(s, "taunt");
  // Up wins: forward again into a jump is a jump, not a dash.
  if (ctx.dash && !input.down && !input.up) return startDash(s, ctx.dash === s.facing ? "dash" : "backdash");
  // The block button guards without walking; with down held it guards low.
  if (input.block && canGuard) return { ...setAction(s, "block"), crouching: input.down, velocity: { x: 0, y: 0 } };
  if (input.up) return { ...startMove(s, "jumpSquat"), crouching: false };
  // A broken guard: down just stands there, back walks away even with an attack coming.
  if (canGuard && (input.down || (backHeld && ctx.threatened))) return { ...setAction(s, "block"), crouching: input.down, velocity: { x: 0, y: 0 } };
  if (forwardHeld !== backHeld) {
    return { ...setAction(s, "walk"), crouching: false, velocity: { x: forwardHeld ? s.facing * WALK_FORWARD_SPEED : -s.facing * WALK_BACK_SPEED, y: 0 } };
  }
  return { ...setAction(s, "idle"), crouching: false, velocity: { x: 0, y: 0 } };
}

/** A dash's speed on frame `f`: fast off the mark, slowing to a stop, `distance` in all (DASH). */
export function dashSpeed(action: "dash" | "backdash", f: number): number {
  const { frames, distance } = action === "dash" ? DASH.forward : DASH.back;
  return f >= frames ? 0 : (distance * 2 * (frames - f)) / (frames * (frames + 1));
}

const dashVelocity = (s: FighterState, action: "dash" | "backdash", f: number) =>
  ({ x: (action === "dash" ? s.facing : -s.facing) * dashSpeed(action, f), y: 0 });

function startDash(s: FighterState, action: "dash" | "backdash"): FighterState {
  return { ...startMove(s, action), crouching: false, velocity: dashVelocity(s, action, 0) };
}

/** A back dash that strikes can't hit yet (DASH.back.invulnerable). Throws still catch it. */
export const isStrikeInvulnerable = (s: FighterState) => s.action === "backdash" && s.actionFrame < DASH.back.invulnerable;

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
    case "parried":
      next = s.actionFrame + 1 >= s.stunFrames
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "jumpSquat": {
      // The wind-up can still turn into a block.
      const backHeld = s.facing === 1 ? ctx.input.left : ctx.input.right;
      if (ctx.controllable && !isGuardBroken(s) && (ctx.input.block || ctx.input.down || (backHeld && ctx.threatened))) {
        next = { ...s, action: "block", actionFrame: 0, crouching: ctx.input.down, velocity: { x: 0, y: 0 } };
      } else if (s.actionFrame + 1 >= JUMP_SQUAT_FRAMES) {
        const dir = ctx.input.right === ctx.input.left ? 0 : ctx.input.right ? 1 : -1;
        next = { ...s, action: "jump", actionFrame: 0, airAttackUsed: false, velocity: { x: dir * JUMP_SPEED_X, y: JUMP_IMPULSE } };
      } else {
        next = { ...s, actionFrame: s.actionFrame + 1 };
      }
      break;
    }
    case "taunt":
      next = s.actionFrame + 1 >= TAUNT.frames ? recover(s, ctx) : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "dash":
    case "backdash": {
      const frames = s.action === "dash" ? DASH.forward.frames : DASH.back.frames;
      next = s.actionFrame + 1 >= frames
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1, velocity: dashVelocity(s, s.action, s.actionFrame + 1) };
      break;
    }
    case "jumpKick":
      // Recovery runs out in the air: keep falling (no second air attack); landing ends it early.
      next = s.actionFrame + 1 >= attackTotalFrames(ATTACKS.jumpKick)
        ? { ...s, action: "jump", actionFrame: 0, hasHit: false }
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "punch":
    case "kick":
    case "uppercut":
    case "lowKick":
    case "charge":
    case "flyingKnee": {
      // Leniency: pressing the other button just after starting a punch or kick makes it a throw (or the signature).
      const core = s.action === "punch" || s.action === "kick" || s.action === "uppercut" || s.action === "lowKick";
      const other = s.action === "punch" || s.action === "uppercut" ? ctx.pressed.kick : ctx.pressed.punch;
      if (core && ctx.controllable && other && s.actionFrame < THROW_LENIENCY_FRAMES) {
        next = startMove(s, ctx.input.down ? ARCHETYPES[ctx.archetype].move : "throw");
        break;
      }
      const attack = ATTACKS[s.action];
      next = s.actionFrame + 1 >= attackTotalFrames(attack)
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      // Lunge (kicks): move forward evenly over the active frames, so the body only
      // closes in once the kick is already out. Contact (hit or block) stops it, so
      // the pushback holds and a kick blocked at the tip of its range is safe.
      // During startup, whatever the walk carried in (startAttack) keeps going.
      if (next.action === s.action) {
        const f = next.actionFrame;
        const lunging = attack.advance && !s.retreating && !s.hasHit && f >= attack.startup && f < attack.startup + attack.active;
        const carried = f < attack.startup && !s.hasHit ? s.velocity.x : 0;
        next = { ...next, velocity: { x: lunging ? (s.facing * attack.advance!) / attack.active : carried, y: 0 } };
      }
      break;
    }
    case "throw":
    case "bearHug":
      next = s.actionFrame + 1 >= grabTotalFrames(GRABS[s.action])
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1 };
      break;
    case "parry":
      next = s.actionFrame + 1 >= PARRY_TOTAL_FRAMES
        ? recover(s, ctx)
        : { ...s, actionFrame: s.actionFrame + 1, velocity: { x: 0, y: 0 } };
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
  return applyPhysics(tickGuard(s, next));
}

/** Guard-break bookkeeping for one stepped frame: the lockout and the blocked-hit window run down; taking a turn starts the count over. */
function tickGuard(was: FighterState, next: FighterState): FighterState {
  const guardBrokenFrames = Math.max(0, next.guardBrokenFrames - 1);
  const tookTurn = next.action !== was.action && (isCommitted(next.action) || isDash(next.action) || next.action === "jumpSquat") && next.action !== "taunt";
  const guardWindow = tookTurn ? 0 : Math.max(0, next.guardWindow - 1);
  const guardHits = guardWindow === 0 ? 0 : next.guardHits;
  return { ...next, guardBrokenFrames, guardWindow, guardHits };
}

/**
 * `minHealth` 1 = practice mode: nobody gets KO'd. A blocked hit that breaks the
 * guard (GUARD_BREAK) comes back as "hurt" with guardBrokenFrames set, still without damage.
 */
export function applyHit(defender: FighterState, attack: AttackId, blocked: boolean, minHealth = 0): FighterState {
  const data = ATTACKS[attack];
  const still = { x: 0, y: defender.velocity.y };
  if (blocked) {
    const guardHits = defender.guardHits + 1;
    if (guardHits >= GUARD_BREAK.blocks) {
      return {
        ...defender, action: "hurt", actionFrame: 0, stunFrames: data.hitstun + GUARD_BREAK.extraStun, velocity: still,
        guardHits: 0, guardWindow: 0, guardBrokenFrames: GUARD_BREAK.lockout,
      };
    }
    // No damage, just locked in block (blockstun, no hitstun).
    return { ...defender, action: "blockstun", actionFrame: 0, stunFrames: data.blockstun, velocity: still, guardHits, guardWindow: GUARD_BREAK.window };
  }
  const health = Math.max(minHealth, defender.health - data.damage);
  const reset = { guardHits: 0, guardWindow: 0 };
  if (health <= 0) return { ...defender, ...reset, health, action: "ko", actionFrame: 0, stunFrames: 0, velocity: still };
  return { ...defender, ...reset, health, action: "hurt", actionFrame: 0, stunFrames: data.hitstun, velocity: still };
}

/** Can be grabbed: grounded and neutral (or parrying). Attacks beat grabs; no throwing someone in hit- or blockstun. */
export function isThrowable(s: FighterState): boolean {
  if (!isGrounded(s)) return false;
  return s.action === "idle" || s.action === "walk" || s.action === "block" || s.action === "taunt" || s.action === "jumpSquat" || s.action === "parry" || isDash(s.action);
}
