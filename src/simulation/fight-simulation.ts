import {
  ATTACKS,
  bodyBoxFor,
  frameGeometry,
  groundAnchorFor,
  hitboxFor,
  BLOCK_LENIENCY_FRAMES,
  guardBlocks,
  INPUT_BUFFER_FRAMES,
  THROW,
  hurtboxesFor,
  poseForAction,
  variantCount,
  variantPoseFor,
  whiffsOverCrouch,
  type AttackId,
  type Box,
  type FighterGeometry,
  type PoseGeometry,
} from "../shared/frame-data";
import type { PoseId } from "../shared/fighter-model";
import { boxCenterX, hitConnects, horizontalOverlap, toWorldBox, type Placement } from "./collision";
import {
  FLOOR_Y,
  HITSTOP_FRAMES,
  STAGE_MARGIN,
  STAGE_WIDTH,
  applyHit,
  clampToStage,
  createFighterState,
  currentAttackPhase,
  isAttack,
  isCommitted,
  isGuarding,
  isThrowable,
  type Presses,
  isCrouching,
  isGrounded,
  stepFighter,
  type FighterState,
} from "./fighter-state-machine";
import { EMPTY_INPUT, type InputFrame } from "./input-frame";
import {
  MAX_HEALTH,
  createMatch,
  restartRound,
  startNextRound,
  tickRound,
  type PlayerIndex,
  type RoundEndReason,
  type RoundOutcome,
  type RoundState,
} from "./round-rules";

export type FightEvent =
  | { type: "roundStart"; round: number }
  | { type: "fight" }
  | { type: "attackActive"; player: PlayerIndex; attack: AttackId }
  | { type: "hit"; attacker: PlayerIndex; defender: PlayerIndex; attack: AttackId; blocked: boolean; damage: number }
  | { type: "grab"; attacker: PlayerIndex; defender: PlayerIndex }
  | { type: "throw"; attacker: PlayerIndex; defender: PlayerIndex; damage: number }
  | { type: "throwTech"; attacker: PlayerIndex; defender: PlayerIndex }
  | { type: "taunt"; player: PlayerIndex }
  | { type: "ko"; player: PlayerIndex }
  | { type: "roundEnd"; outcome: RoundOutcome; reason: RoundEndReason }
  | { type: "matchEnd"; winner: RoundOutcome };

export interface FightState {
  frame: number;
  fighters: [FighterState, FighterState];
  round: RoundState;
  /** Events produced by the most recent step only. */
  events: FightEvent[];
}

/** Practice mode refills health after this many frames back in neutral. */
export const PRACTICE_REFILL_FRAMES = 60;

export const START_POSITIONS: [number, number] = [STAGE_WIDTH / 2 - 240, STAGE_WIDTH / 2 + 240];

export function poseOf(state: FighterState): PoseId {
  if (isCrouching(state)) return "crouch";
  return poseForAction(state.action, state.actionFrame);
}

/** The pose shown this frame and which captured version of it. */
export function frameOf(state: FighterState): { poseId: PoseId; variant: number } {
  const poseId = poseOf(state);
  // Uppercut / low kick show the second punch / kick captures on their active frames.
  if (isAttack(state.action)) {
    const shown = ATTACKS[state.action].pose;
    return { poseId, variant: poseId === shown.poseId ? shown.variant : 0 };
  }
  return { poseId, variant: poseId === variantPoseFor(state.action) ? state.variant : 0 };
}

export function currentGeometry(geometry: FighterGeometry, state: FighterState): PoseGeometry {
  const { poseId, variant } = frameOf(state);
  return frameGeometry(geometry, poseId, variant);
}

export function placementOf(geometry: FighterGeometry, state: FighterState): Placement {
  const { poseId, variant } = frameOf(state);
  return { position: state.position, facing: state.facing, anchor: groundAnchorFor(geometry, poseId, variant) };
}

/**
 * The frame whose hurtboxes count. Walking alternates the walk and idle captures
 * for a stride, but the hurtboxes stay the idle ones: otherwise the stride's
 * leading leg makes you a bigger target on every other step. Randomly picked
 * alternates (hurt, KO, win/taunt) are cosmetic: a random reaction mustn't
 * change whether the next attack connects.
 */
export function hurtFrameOf(state: FighterState): { poseId: PoseId; variant: number } {
  if (state.action === "walk") return { poseId: "idle", variant: 0 };
  const frame = frameOf(state);
  return variantPoseFor(state.action) === null ? frame : { ...frame, variant: 0 };
}

/** A fighter's hurtboxes (sprite space) and where they're placed in the world. */
export function hurtboxesOf(geometry: FighterGeometry, state: FighterState): { boxes: Box[]; placement: Placement } {
  const frame = hurtFrameOf(state);
  return {
    boxes: hurtboxesFor(frameGeometry(geometry, frame.poseId, frame.variant), frame),
    placement: { position: state.position, facing: state.facing, anchor: groundAnchorFor(geometry, frame.poseId, frame.variant) },
  };
}

/**
 * The uppercut is the anti-air: during its startup and active frames, attacks
 * from airborne fighters don't hit it. Ground attacks still do, and it's very
 * punishable on block, so it's a read, not a free answer to everything.
 */
export function antiAirImmune(defender: FighterState, attacker: FighterState): boolean {
  return defender.action === "uppercut" && currentAttackPhase(defender) !== "recovery" && !isGrounded(attacker);
}

/** Small deterministic PRNG (mulberry32) so variant choices replay identically. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FighterBoxes {
  /** Head, torso and limb boxes. */
  hurtboxes: Box[];
  /** Push box: the idle pose's body box, so it's stable across hard cuts. */
  bodyBox: Box;
  hitbox: Box | null;
}

/** World-space boxes for a fighter's current frame (used by collision and the debug overlay). */
export function worldBoxesOf(geometry: FighterGeometry, state: FighterState): FighterBoxes {
  const pose = currentGeometry(geometry, state);
  const placement = placementOf(geometry, state);
  const hurt = hurtboxesOf(geometry, state);
  const active = isAttack(state.action) && currentAttackPhase(state) === "active";
  // The push box comes from the idle pose for every frame: per-pose boxes jump around
  // on hard cuts (a walk stride's box sits well behind the feet), which let fighters tunnel through each other.
  const idlePlacement = { position: state.position, facing: state.facing, anchor: groundAnchorFor(geometry, "idle") };
  return {
    hurtboxes: hurt.boxes.map((b) => toWorldBox(b, hurt.placement)),
    bodyBox: toWorldBox(bodyBoxFor(geometry.idle), idlePlacement),
    hitbox: active && isAttack(state.action) ? toWorldBox(hitboxFor(state.action, pose), placement) : null,
  };
}

export class FightSimulation {
  private state: FightState;
  private previousInputs: [InputFrame, InputFrame] = [EMPTY_INPUT, EMPTY_INPUT];
  /** Frames since each fighter last held back / down (for block leniency). */
  private guardHistory = [{ back: 99, down: 99 }, { back: 99, down: 99 }];
  /** Frames left on each buffered press (0 = none). */
  private buffers: [Record<keyof Presses, number>, Record<keyof Presses, number>] = [{ punch: 0, kick: 0 }, { punch: 0, kick: 0 }];

  private readonly startPositions: [number, number];
  private readonly random: () => number;
  /** Practice: no clock, no KO, health refills once a fighter is back to neutral. */
  readonly practice: boolean;
  private calmFrames: [number, number] = [0, 0];
  /** Wins when the current round began, so restarting it undoes a KO from its outro. */
  private winsAtRoundStart: [number, number] = [0, 0];

  constructor(
    private readonly geometry: [FighterGeometry, FighterGeometry],
    options: { startPositions?: [number, number]; seed?: number; practice?: boolean } = {},
  ) {
    this.practice = options.practice ?? false;
    this.startPositions = options.startPositions ?? START_POSITIONS;
    this.random = createRng(options.seed ?? 1);
    this.state = {
      frame: 0,
      fighters: this.freshFighters(),
      round: createMatch(),
      events: [{ type: "roundStart", round: 1 }],
    };
  }

  /** Players swap sides every round, so nobody is stuck with the same side all match. */
  private freshFighters(roundNumber = 1): [FighterState, FighterState] {
    const swap = roundNumber % 2 === 0;
    const [left, right] = this.startPositions;
    return [
      createFighterState(swap ? right : left, swap ? -1 : 1, MAX_HEALTH),
      createFighterState(swap ? left : right, swap ? 1 : -1, MAX_HEALTH),
    ];
  }

  get current(): FightState {
    return this.state;
  }

  getGeometry(player: PlayerIndex): FighterGeometry {
    return this.geometry[player];
  }

  /** After the round-result screen: reset positions and health for the next round. */
  startNextRound(): FightState {
    const round = startNextRound(this.state.round);
    if (round === this.state.round) return this.state;
    this.winsAtRoundStart = [...round.wins];
    return this.beginRound(round);
  }

  /** Pause menu: replay the current round from its intro (positions, health and clock reset). */
  restartRound(): FightState {
    return this.beginRound(restartRound(this.state.round, this.winsAtRoundStart));
  }

  private beginRound(round: RoundState): FightState {
    this.previousInputs = [EMPTY_INPUT, EMPTY_INPUT];
    this.buffers = [{ punch: 0, kick: 0 }, { punch: 0, kick: 0 }];
    this.guardHistory = [{ back: 99, down: 99 }, { back: 99, down: 99 }];
    this.calmFrames = [0, 0];
    this.state = { frame: this.state.frame, fighters: this.freshFighters(round.roundNumber), round, events: [{ type: "roundStart", round: round.roundNumber }] };
    return this.state;
  }

  step(inputs: [InputFrame, InputFrame]): FightState {
    const prev = this.state;
    const events: FightEvent[] = [];
    const frame = prev.frame + 1;

    for (const i of [0, 1] as const) {
      const f = prev.fighters[i];
      const back = f.facing === 1 ? inputs[i].left : inputs[i].right;
      this.guardHistory[i].back = back ? 0 : this.guardHistory[i].back + 1;
      this.guardHistory[i].down = inputs[i].down ? 0 : this.guardHistory[i].down + 1;
    }
    // New presses go into the buffer (even during hitstop, so they fire right after it).
    for (const i of [0, 1] as const) {
      for (const button of ["punch", "kick"] as const) {
        if (inputs[i][button] && !this.previousInputs[i][button]) this.buffers[i][button] = INPUT_BUFFER_FRAMES;
      }
    }
    this.previousInputs = inputs;

    // Hitstop: both fighters freeze, the clock too.
    if (prev.fighters[0].hitstopFrames > 0 || prev.fighters[1].hitstopFrames > 0) {
      const fighters = prev.fighters.map((f) => ({ ...f, hitstopFrames: Math.max(0, f.hitstopFrames - 1) })) as [FighterState, FighterState];
      this.state = { ...prev, frame, fighters, events };
      return this.state;
    }

    const phase = prev.round.phase;
    if (phase === "roundOver" || phase === "matchOver") {
      this.state = { ...prev, frame, events };
      return this.state;
    }

    const controllable = phase === "fighting";
    const pressed = (i: number): Presses =>
      controllable ? { punch: this.buffers[i].punch > 0, kick: this.buffers[i].kick > 0 } : { punch: false, kick: false };
    let fighters = [0, 1].map((i) =>
      stepFighter(prev.fighters[i], {
        input: controllable ? inputs[i] : EMPTY_INPUT,
        pressed: pressed(i),
        opponent: prev.fighters[1 - i],
        controllable,
      }),
    ) as [FighterState, FighterState];
    if (controllable) fighters = this.resolveGrabs(fighters, events);
    // A press that started a move is used up; others count down.
    for (const i of [0, 1] as const) {
      const started = isCommitted(fighters[i].action) && fighters[i].action !== prev.fighters[i].action;
      for (const button of ["punch", "kick"] as const) {
        this.buffers[i][button] = started ? 0 : Math.max(0, this.buffers[i][button] - 1);
      }
    }
    fighters = fighters.map((f, i) => (f.action !== prev.fighters[i].action ? this.withVariant(i as PlayerIndex, f) : f)) as [FighterState, FighterState];

    for (const i of [0, 1] as const) {
      const f = fighters[i];
      if (f.action === "taunt" && prev.fighters[i].action !== "taunt") events.push({ type: "taunt", player: i });
      if (isAttack(f.action) && f.actionFrame === ATTACKS[f.action].startup) {
        events.push({ type: "attackActive", player: i, attack: f.action });
      }
    }

    if (controllable) fighters = this.resolveThrows(fighters, events);
    if (controllable) fighters = this.resolveHits(fighters, events);
    fighters = this.pushApart(fighters);

    if (this.practice) fighters = this.practiceRefill(fighters);
    let round = this.practice && prev.round.phase === "fighting"
      ? { ...prev.round, phaseFrame: prev.round.phaseFrame + 1 } // the clock never runs and nobody gets KO'd
      : tickRound(prev.round, [fighters[0].health, fighters[1].health]);
    if (round.phase === "fighting" && prev.round.phase === "intro") events.push({ type: "fight" });
    if (round.phase === "outro" && prev.round.phase === "fighting") {
      events.push({ type: "roundEnd", outcome: round.roundWinner!, reason: round.roundEndReason! });
    }
    if (round.phase === "matchOver" && prev.round.phase !== "matchOver") events.push({ type: "matchEnd", winner: round.matchWinner! });
    if (round.phase === "outro") fighters = this.applyOutroPoses(fighters, round);

    this.state = { frame, fighters, round, events };
    return this.state;
  }

  /** Practice: health (floored at 1 where damage is applied) refills after a second of neutral. */
  private practiceRefill(fighters: [FighterState, FighterState]): [FighterState, FighterState] {
    return fighters.map((f, i) => {
      let next = f;
      const neutral = next.action === "idle" || next.action === "walk" || next.action === "block";
      this.calmFrames[i] = neutral ? this.calmFrames[i] + 1 : 0;
      if (this.calmFrames[i] >= PRACTICE_REFILL_FRAMES && next.health < MAX_HEALTH) next = { ...next, health: MAX_HEALTH };
      return next;
    }) as [FighterState, FighterState];
  }

  /** Pick which captured version of the new action's pose this fighter shows. */
  private withVariant(player: PlayerIndex, f: FighterState): FighterState {
    const poseId = variantPoseFor(f.action);
    const n = poseId ? variantCount(this.geometry[player], poseId) : 1;
    const variant = n > 1 ? Math.floor(this.random() * n) : 0;
    return variant === f.variant ? f : { ...f, variant };
  }

  /** On a throw's active frame: grab a throwable opponent within range. */
  private resolveThrows(fighters: [FighterState, FighterState], events: FightEvent[]): [FighterState, FighterState] {
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    for (const a of [0, 1] as const) {
      const attacker = fighters[a];
      if (attacker.action !== "throw" || attacker.hasHit || attacker.actionFrame !== THROW.startup) continue;
      const d = (1 - a) as PlayerIndex;
      if (!isThrowable(fighters[d])) continue;
      const ab = worldBoxesOf(this.geometry[a], attacker).bodyBox;
      const db = worldBoxesOf(this.geometry[d], fighters[d]).bodyBox;
      const gap = Math.max(db.x - (ab.x + ab.width), ab.x - (db.x + db.width));
      if (gap > THROW.range) continue;
      next[a] = { ...attacker, hasHit: true };
      next[d] = this.withVariant(d, { ...fighters[d], action: "grabbed", actionFrame: 0, stunFrames: THROW.techWindow, velocity: { x: 0, y: 0 } });
      this.buffers[d] = { punch: 0, kick: 0 }; // only presses during the grab count as a tech
      events.push({ type: "grab", attacker: a, defender: d });
    }
    return next;
  }

  /** A grabbed fighter breaks free with punch + kick during the tech window; otherwise the throw lands. */
  private resolveGrabs(fighters: [FighterState, FighterState], events: FightEvent[]): [FighterState, FighterState] {
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    for (const d of [0, 1] as const) {
      const grabbed = fighters[d];
      if (grabbed.action !== "grabbed") continue;
      const a = (1 - d) as PlayerIndex;
      const thrower = fighters[a];
      const away = Math.sign(grabbed.position.x - thrower.position.x) || thrower.facing;
      if (this.buffers[d].punch > 0 && this.buffers[d].kick > 0) {
        // Tech: both back to neutral, a little apart.
        this.buffers[d] = { punch: 0, kick: 0 };
        next[d] = { ...grabbed, action: "idle", actionFrame: 0, stunFrames: 0, position: { ...grabbed.position, x: clampToStage(grabbed.position.x + away * 40) } };
        next[a] = { ...thrower, action: "idle", actionFrame: 0, hasHit: false, position: { ...thrower.position, x: clampToStage(thrower.position.x - away * 20) } };
        events.push({ type: "throwTech", attacker: a, defender: d });
        continue;
      }
      if (grabbed.actionFrame < grabbed.stunFrames) continue;
      const health = Math.max(this.practice ? 1 : 0, grabbed.health - THROW.damage);
      const pushed = clampToStage(grabbed.position.x + away * THROW.throwDistance);
      const remainder = away * THROW.throwDistance - (pushed - grabbed.position.x);
      next[d] = health <= 0
        ? { ...grabbed, health, action: "ko", actionFrame: 0, stunFrames: 0, position: { ...grabbed.position, x: pushed }, hitstopFrames: HITSTOP_FRAMES + 2 }
        : { ...grabbed, health, action: "hurt", actionFrame: 0, stunFrames: THROW.releaseHitstun, position: { ...grabbed.position, x: pushed }, hitstopFrames: HITSTOP_FRAMES + 2 };
      next[a] = { ...thrower, hitstopFrames: HITSTOP_FRAMES + 2, position: { ...thrower.position, x: clampToStage(thrower.position.x - remainder) } };
      events.push({ type: "throw", attacker: a, defender: d, damage: grabbed.health - health });
      if (health <= 0) events.push({ type: "ko", player: d });
    }
    return next;
  }

  private resolveHits(fighters: [FighterState, FighterState], events: FightEvent[]): [FighterState, FighterState] {
    const hits: { attacker: PlayerIndex; attack: AttackId }[] = [];
    for (const a of [0, 1] as const) {
      const attacker = fighters[a];
      if (!isAttack(attacker.action) || attacker.hasHit || currentAttackPhase(attacker) !== "active") continue;
      const d = (1 - a) as PlayerIndex;
      const defender = fighters[d];
      if (defender.action === "ko") continue;
      const atkGeo = this.geometry[a];
      const defGeo = this.geometry[d];
      const hitbox = hitboxFor(attacker.action, currentGeometry(atkGeo, attacker));
      if (antiAirImmune(defender, attacker)) continue;
      if (whiffsOverCrouch(ATTACKS[attacker.action].level) && isCrouching(defender)) continue;
      const hurt = hurtboxesOf(defGeo, defender);
      if (hitConnects(hitbox, placementOf(atkGeo, attacker), hurt.boxes, hurt.placement)) {
        hits.push({ attacker: a, attack: attacker.action });
      }
    }
    // Resolve simultaneously so trades are symmetric.
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    for (const { attacker: a, attack } of hits) {
      const d = (1 - a) as PlayerIndex;
      const defender = next[d];
      const level = ATTACKS[attack].level;
      // A held guard, or a free fighter who let go of back/down a moment ago (leniency).
      const lenient = (defender.action === "idle" || defender.action === "walk" || defender.action === "jumpSquat") && isGrounded(defender)
        && (this.guardHistory[d].back < BLOCK_LENIENCY_FRAMES || this.guardHistory[d].down < BLOCK_LENIENCY_FRAMES);
      const crouching = isGuarding(defender) ? defender.crouching : this.guardHistory[d].down < BLOCK_LENIENCY_FRAMES;
      const blocked = (isGuarding(defender) || lenient) && isGrounded(defender) && guardBlocks(level, crouching);
      const before = defender.health;
      let hitDefender = applyHit({ ...defender, crouching }, attack, blocked, this.practice ? 1 : 0);
      if (!blocked) hitDefender = this.withVariant(d, hitDefender); // new hurt/ko reaction
      const away = Math.sign(defender.position.x - fighters[a].position.x) || fighters[a].facing; // cross-ups push the right way
      const pushed = clampToStage(hitDefender.position.x + away * ATTACKS[attack].pushback);
      const remainder = away * ATTACKS[attack].pushback - (pushed - hitDefender.position.x);
      hitDefender = { ...hitDefender, position: { ...hitDefender.position, x: pushed } };
      next[d] = hitDefender;
      // Cornered defender: the attacker takes the rest of the pushback.
      if (remainder !== 0) {
        next[a] = { ...next[a], position: { ...next[a].position, x: clampToStage(next[a].position.x - remainder) } };
      }
      next[a] = { ...next[a], hasHit: true };
      events.push({ type: "hit", attacker: a, defender: d, attack, blocked, damage: before - hitDefender.health });
      if (hitDefender.action === "ko") events.push({ type: "ko", player: d });
    }
    if (hits.length) {
      next[0] = { ...next[0], hitstopFrames: HITSTOP_FRAMES };
      next[1] = { ...next[1], hitstopFrames: HITSTOP_FRAMES };
    }
    return next;
  }

  /** Body boxes can't overlap: split the overlap between both fighters, respecting the walls. */
  private pushApart(fighters: [FighterState, FighterState]): [FighterState, FighterState] {
    // Airborne fighters pass over each other (cross-ups); landing on someone pushes apart again.
    if (fighters.some((f) => f.position.y < FLOOR_Y)) return fighters;
    const a = worldBoxesOf(this.geometry[0], fighters[0]).bodyBox;
    const b = worldBoxesOf(this.geometry[1], fighters[1]).bodyBox;
    const overlap = horizontalOverlap(a, b);
    if (overlap <= 0) return fighters;
    const leftIsP1 = boxCenterX(a) !== boxCenterX(b) ? boxCenterX(a) < boxCenterX(b) : fighters[0].position.x <= fighters[1].position.x;
    const [li, ri] = leftIsP1 ? [0, 1] : [1, 0];
    const left = fighters[li];
    const right = fighters[ri];
    let lx = left.position.x - overlap / 2;
    let rx = right.position.x + overlap / 2;
    if (lx < STAGE_MARGIN) { rx += STAGE_MARGIN - lx; lx = STAGE_MARGIN; }
    if (rx > STAGE_WIDTH - STAGE_MARGIN) { lx -= rx - (STAGE_WIDTH - STAGE_MARGIN); rx = STAGE_WIDTH - STAGE_MARGIN; }
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    next[li] = { ...left, position: { ...left.position, x: clampToStage(lx) } };
    next[ri] = { ...right, position: { ...right.position, x: clampToStage(rx) } };
    return next;
  }

  private applyOutroPoses(fighters: [FighterState, FighterState], round: RoundState): [FighterState, FighterState] {
    if (round.roundWinner === "draw" || round.roundWinner === null) return fighters;
    const w = round.roundWinner;
    const winner = fighters[w];
    if (winner.action === "win" || winner.action === "ko" || !isGrounded(winner) || isCommitted(winner.action) || winner.action === "hurt") return fighters;
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    next[w] = this.withVariant(w, { ...winner, action: "win", actionFrame: 0, velocity: { x: 0, y: 0 } });
    return next;
  }
}
