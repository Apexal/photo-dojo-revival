import {
  ATTACKS,
  bodyBoxFor,
  frameGeometry,
  groundAnchorFor,
  hitboxFor,
  BLOCK_LENIENCY_FRAMES,
  guardBlocks,
  INPUT_BUFFER_FRAMES,
  KNOCKDOWN,
  THROW,
  hurtboxesFor,
  idleSwayAt,
  poseForAction,
  sequenceFor,
  tweenAtFrame,
  variantCount,
  variantPoseFor,
  whiffsOverCrouch,
  type AttackId,
  type Box,
  type FighterGeometry,
  type PoseGeometry,
} from "../shared/frame-data";
import type { PoseId } from "../shared/fighter-model";
import { midShoulder, torsoLength } from "../shared/pose-geometry";
import { boxCenterX, contactPoint, horizontalOverlap, toWorldBox, type Placement } from "./collision";
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
  isDown,
  isGrounded,
  isUntouchable,
  airFrames,
  knockDown,
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
  /** `at`: where it landed (world space), for the hit marker. */
  | { type: "hit"; attacker: PlayerIndex; defender: PlayerIndex; attack: AttackId; blocked: boolean; damage: number; at: { x: number; y: number } }
  | { type: "grab"; attacker: PlayerIndex; defender: PlayerIndex }
  | { type: "throw"; attacker: PlayerIndex; defender: PlayerIndex; damage: number }
  | { type: "throwTech"; attacker: PlayerIndex; defender: PlayerIndex }
  | { type: "taunt"; player: PlayerIndex }
  | { type: "ko"; player: PlayerIndex }
  /** Sent flying by a throw or a hit in the air; `landed` when they (or a KO'd fighter) hit the floor. */
  | { type: "knockdown"; player: PlayerIndex }
  | { type: "landed"; player: PlayerIndex }
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

export interface FrameTween { from: { poseId: PoseId; variant: number }; to: { poseId: PoseId; variant: number }; t: number }

/**
 * The tween to draw this frame instead of frameOf's capture, or null for a hard
 * cut. Rendering only: frameOf (the tween's from-pose) stays what collides.
 */
export function tweenOf(state: FighterState): FrameTween | null {
  const sequence = isCrouching(state) ? null : sequenceFor(state.action);
  const tween = sequence && tweenAtFrame(sequence, state.actionFrame);
  if (!tween) return null;
  const shown = isAttack(state.action) ? ATTACKS[state.action].pose : null;
  const end = (poseId: PoseId) => ({ poseId, variant: poseId === shown?.poseId ? shown.variant : 0 });
  return { from: end(tween.from), to: end(tween.to), t: tween.t };
}

/**
 * Standing still: sway between the stance and the second stance. Rendering
 * only; hurtboxes stay the main stance's (frameOf never shows variant 1 of idle).
 */
export function idleSwayOf(state: FighterState): FrameTween | null {
  if (state.action !== "idle" || isCrouching(state)) return null;
  return { from: { poseId: "idle", variant: 0 }, to: { poseId: "idle", variant: 1 }, t: idleSwayAt(state.actionFrame) };
}

/** Every from/to pair a move can tween between (t is that pair's first frame), to build meshes before the fight. */
export function allTweens(): FrameTween[] {
  const found = new Map<string, FrameTween>();
  for (const action of ["punch", "kick", "uppercut", "lowKick", "jumpKick", "throw"] as const) {
    const frames = sequenceFor(action)!.reduce((sum, e) => sum + e.frames, 0);
    for (let actionFrame = 0; actionFrame < frames; actionFrame++) {
      const tween = tweenOf({ ...createFighterState(0, 1, MAX_HEALTH), action, actionFrame });
      if (!tween) continue;
      const key = `${tween.from.poseId}#${tween.from.variant}>${tween.to.poseId}#${tween.to.variant}`;
      if (!found.has(key)) found.set(key, tween);
    }
  }
  return [...found.values()];
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

/** How far below the shoulders (in torso lengths) a hit still counts as a head hit: the upper chest. */
export const HEAD_HIT_BELOW_SHOULDERS = 0.25;

/**
 * World y above which a hit on this fighter, in the pose they're in now, is a
 * head hit. A hit's contact point is the middle of its biggest overlap, usually
 * with the torso box, so a punch to the face lands around shoulder height.
 */
export function headHitLineY(geometry: FighterGeometry, state: FighterState): number {
  const { landmarks } = currentGeometry(geometry, state);
  const { anchor, position } = placementOf(geometry, state);
  return position.y + (midShoulder(landmarks).y - anchor.y) + HEAD_HIT_BELOW_SHOULDERS * torsoLength(landmarks);
}

/** A fighter's hurtboxes (sprite space) and where they're placed in the world. */
export function hurtboxesOf(geometry: FighterGeometry, state: FighterState): { boxes: Box[]; placement: Placement } {
  const frame = hurtFrameOf(state);
  return {
    // Knocked down or KO'd: nothing to hit.
    boxes: isUntouchable(state) ? [] : hurtboxesFor(frameGeometry(geometry, frame.poseId, frame.variant), frame),
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
      const f = fighters[i], was = prev.fighters[i];
      if (f.action === "taunt" && was.action !== "taunt") events.push({ type: "taunt", player: i });
      const fell = (was.action === "knockdown" && f.action === "downed") || (f.action === "ko" && !isGrounded(was) && isGrounded(f));
      if (fell) events.push({ type: "landed", player: i });
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
  /** A random captured version for a new action (taunt / win). Hit reactions are chosen by where the hit lands instead. */
  private withVariant(player: PlayerIndex, f: FighterState): FighterState {
    if (variantPoseFor(f.action) === "hurt") return f;
    const poseId = variantPoseFor(f.action);
    const n = poseId ? variantCount(this.geometry[player], poseId) : 1;
    const variant = n > 1 ? Math.floor(this.random() * n) : 0;
    return variant === f.variant ? f : { ...f, variant };
  }

  /**
   * Which hurt photo a clean hit shows: hit in the head (`at`, world space,
   * above headHitLineY) and it's the second one, hands on the face; anywhere
   * else, the main one.
   * Cosmetic: hurtboxes always come from the main hurt pose.
   */
  private reactionVariant(player: PlayerIndex, defender: FighterState, at: { x: number; y: number }): number {
    if (variantCount(this.geometry[player], "hurt") < 2) return 0;
    return at.y < headHitLineY(this.geometry[player], defender) ? 1 : 0;
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
      const away = (Math.sign(grabbed.position.x - thrower.position.x) || thrower.facing) as 1 | -1;
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
      const lands = clampToStage(grabbed.position.x + away * THROW.throwDistance);
      const remainder = away * THROW.throwDistance - (lands - grabbed.position.x);
      // Flung, not teleported: the sideways speed is aimed so they land `throwDistance` away.
      const thrown = knockDown({ ...grabbed, health, variant: 0, hitstopFrames: HITSTOP_FRAMES + 2 }, away, (lands - grabbed.position.x) / airFrames(KNOCKDOWN.launch.y));
      next[d] = health <= 0 ? { ...thrown, action: "ko" } : thrown;
      if (health > 0) events.push({ type: "knockdown", player: d });
      next[a] = { ...thrower, hitstopFrames: HITSTOP_FRAMES + 2, position: { ...thrower.position, x: clampToStage(thrower.position.x - remainder) } };
      events.push({ type: "throw", attacker: a, defender: d, damage: grabbed.health - health });
      if (health <= 0) events.push({ type: "ko", player: d });
    }
    return next;
  }

  private resolveHits(fighters: [FighterState, FighterState], events: FightEvent[]): [FighterState, FighterState] {
    const hits: { attacker: PlayerIndex; attack: AttackId; at: { x: number; y: number } }[] = [];
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
      const at = contactPoint(hitbox, placementOf(atkGeo, attacker), hurt.boxes, hurt.placement);
      if (at) hits.push({ attacker: a, attack: attacker.action, at });
    }
    // Resolve simultaneously so trades are symmetric.
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    for (const { attacker: a, attack, at } of hits) {
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
      if (!blocked) hitDefender = { ...hitDefender, variant: this.reactionVariant(d, defender, at) };
      const away = (Math.sign(defender.position.x - fighters[a].position.x) || fighters[a].facing) as 1 | -1; // cross-ups push the right way
      // A KO'd fighter falls back; an anti-air hit knocks down (no juggles: they can't be hit again till they're up).
      if (hitDefender.action === "ko") hitDefender = { ...knockDown(hitDefender, away), action: "ko" };
      else if (!blocked && !isGrounded(defender) && ATTACKS[attack].knocksDownInAir) {
        hitDefender = knockDown(hitDefender, away);
        events.push({ type: "knockdown", player: d });
      }
      const pushed = clampToStage(hitDefender.position.x + away * ATTACKS[attack].pushback);
      const remainder = away * ATTACKS[attack].pushback - (pushed - hitDefender.position.x);
      hitDefender = { ...hitDefender, position: { ...hitDefender.position, x: pushed } };
      next[d] = hitDefender;
      // Cornered defender: the attacker takes the rest of the pushback.
      if (remainder !== 0) {
        next[a] = { ...next[a], position: { ...next[a].position, x: clampToStage(next[a].position.x - remainder) } };
      }
      next[a] = { ...next[a], hasHit: true };
      events.push({ type: "hit", attacker: a, defender: d, attack, blocked, damage: before - hitDefender.health, at });
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
    // Nobody pushes against someone knocked down or KO'd: walk over them (getting up pushes apart again).
    if (fighters.some((f) => f.position.y < FLOOR_Y || isUntouchable(f))) return fighters;
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
    if (winner.action === "win" || winner.action === "ko" || !isGrounded(winner) || isCommitted(winner.action) || winner.action === "hurt" || isDown(winner)) return fighters;
    const next: [FighterState, FighterState] = [fighters[0], fighters[1]];
    next[w] = this.withVariant(w, { ...winner, action: "win", actionFrame: 0, velocity: { x: 0, y: 0 } });
    return next;
  }
}
