import { LANDMARK, type NormalizedLandmark } from "../../shared/fighter-model";
import { MAX_HEALTH } from "../../simulation/round-rules";
import type { RoundSummary } from "../../simulation/match-stats";
import { torsoLength } from "../../shared/pose-geometry";
import type { Point } from "./arap";

/*
 * Battle damage: cartoon scars stuck to a fighter as the match wears on (a
 * black eye, a bandaged arm, plasters, a bruised shin, a bump on the head...),
 * one more for every stretch of health lost, kept from round to round and onto
 * the stats page. Rendering only. Everything here is pure: where each scar sits,
 * worked out from the landmarks of whatever is on screen (a photo, a morph, a
 * ragdoll), so it follows the body wherever it goes; battle-damage-view.ts draws them.
 */

export type ScarKind = "blackEye" | "armWrap" | "bandAid" | "shinBruise" | "plaster" | "kneePatch" | "bump" | "fatLip" | "noseTape";

/** The order scars appear in, one per DAMAGE_PER_SCAR of health lost over the match: face and body by turns, so it spreads. */
export const SCAR_ORDER: readonly ScarKind[] = ["blackEye", "armWrap", "bandAid", "shinBruise", "plaster", "kneePatch", "bump", "fatLip", "noseTape"];

/** Health lost (over the match) per scar: a fighter beaten twice has them all. */
export const DAMAGE_PER_SCAR = (2 * MAX_HEALTH) / SCAR_ORDER.length;

/** How many scars a fighter has, from the health they've lost over the match so far. */
export function scarCount(damageTaken: number): number {
  return Math.max(0, Math.min(SCAR_ORDER.length, Math.floor(damageTaken / DAMAGE_PER_SCAR)));
}

/** Health a player lost in the rounds already over (the current round's is MAX_HEALTH minus their health now). */
export function damageInRounds(rounds: readonly RoundSummary[], player: 0 | 1): number {
  return rounds.reduce((sum, r) => sum + (MAX_HEALTH - r.health[player]), 0);
}

/**
 * A head, in the landmarks' own space: `forward` points out of the face (ear
 * to nose), `up` out of the top of the head, both unit vectors; `size` is the
 * ear-to-nose distance, the unit scars are sized in.
 */
export interface Head { eye: Point; ear: Point; nose: Point; mouth: Point; forward: Point; up: Point; size: number }

/** A face or limb this unsure isn't scarred (turned away, hidden, or out of the photo). */
const MIN_VISIBILITY = 0.4;

/**
 * The head in a set of landmarks (facing right, y down), or null when the face
 * can't be seen well enough. Side-on, one eye and one ear are hidden: the
 * surer of each pair is used.
 */
export function headOf(l: readonly NormalizedLandmark[]): Head | null {
  const surer = (a: number, b: number) => (l[a].visibility >= l[b].visibility ? l[a] : l[b]);
  const nose = l[LANDMARK.nose];
  const eye = surer(LANDMARK.leftEye, LANDMARK.rightEye);
  const ear = surer(LANDMARK.leftEar, LANDMARK.rightEar);
  const mouth = surer(LANDMARK.mouthLeft, LANDMARK.mouthRight);
  if (Math.min(nose.visibility, eye.visibility, ear.visibility) < MIN_VISIBILITY) return null;
  const dx = nose.x - ear.x, dy = nose.y - ear.y;
  const size = Math.hypot(dx, dy);
  if (size < 1) return null;
  const forward = { x: dx / size, y: dy / size };
  // A quarter turn back from forward: (1, 0) → (0, -1), the top of a head facing right.
  const up = { x: forward.y, y: -forward.x };
  return { eye, ear, nose, mouth, forward, up, size };
}

/**
 * One scar: its centre, its own axes (along the face or limb, and up the head
 * or across the limb; unit vectors) and its size, all in the landmarks' space.
 * Face scars are sized in head sizes, body scars in torso lengths.
 */
export interface Scar { kind: ScarKind; at: Point; forward: Point; up: Point; size: number }

type FaceScar = "blackEye" | "bandAid" | "plaster" | "bump" | "fatLip" | "noseTape";
type BodyScar = Exclude<ScarKind, FaceScar>;

/** Where each face scar goes: a point on the head as a mix of its landmarks, offset along forward and up (in head sizes), and a tilt (radians, nose-up positive). */
const FACE_PLACES: Record<FaceScar, { from: (h: Head) => Point; forward: number; up: number; tilt: number }> = {
  blackEye: { from: (h) => h.eye, forward: 0, up: 0, tilt: 0 },
  // Across the cheekbone, below and behind the eye.
  bandAid: { from: (h) => h.eye, forward: -0.25, up: -0.55, tilt: -0.45 },
  // On the forehead, up at the hairline.
  plaster: { from: (h) => h.eye, forward: -0.2, up: 0.85, tilt: 0.3 },
  // Out of the crown, above the ear.
  bump: { from: (h) => h.ear, forward: 0.05, up: 1.05, tilt: 0 },
  fatLip: { from: (h) => h.mouth, forward: 0.05, up: 0, tilt: 0 },
  // Across the bridge of the nose.
  noseTape: { from: (h) => ({ x: (h.eye.x + h.nose.x) / 2, y: (h.eye.y + h.nose.y) / 2 }), forward: 0.05, up: 0.05, tilt: 0 },
};

/** Where each body scar goes: a fraction `t` of the way down a limb bone, on whichever side's limb is surer (the near one, side-on). */
const BODY_PLACES: Record<BodyScar, { bone: readonly [Joint, Joint]; t: number }> = {
  // A bandage wrapped round the middle of the forearm.
  armWrap: { bone: ["Elbow", "Wrist"], t: 0.5 },
  shinBruise: { bone: ["Knee", "Ankle"], t: 0.45 },
  // Crossed plasters on the kneecap.
  kneePatch: { bone: ["Knee", "Ankle"], t: 0.05 },
};

type Joint = "Elbow" | "Wrist" | "Knee" | "Ankle";

const isFace = (kind: ScarKind): kind is FaceScar => kind in FACE_PLACES;

const turn = (v: Point, a: number): Point => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

function faceScar(kind: FaceScar, head: Head): Scar {
  const place = FACE_PLACES[kind];
  const base = place.from(head);
  const at = {
    x: base.x + (head.forward.x * place.forward + head.up.x * place.up) * head.size,
    y: base.y + (head.forward.y * place.forward + head.up.y * place.up) * head.size,
  };
  // Tilting nose-up turns forward toward up: against the screen's clockwise turn (y down).
  return { kind, at, forward: turn(head.forward, -place.tilt), up: turn(head.up, -place.tilt), size: head.size };
}

/** A body scar on the surer of the two limbs, or null when neither can be seen well enough. */
function bodyScar(kind: BodyScar, l: readonly NormalizedLandmark[], torso: number): Scar | null {
  const { bone, t } = BODY_PLACES[kind];
  const ends = (["left", "right"] as const).map((side) => [l[LANDMARK[`${side}${bone[0]}`]], l[LANDMARK[`${side}${bone[1]}`]]] as const);
  const [a, b] = ends.reduce((best, e) => (Math.min(e[0].visibility, e[1].visibility) > Math.min(best[0].visibility, best[1].visibility) ? e : best));
  if (Math.min(a.visibility, b.visibility) < MIN_VISIBILITY) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1 || torso < 1) return null;
  const forward = { x: dx / length, y: dy / length };
  return { kind, at: { x: a.x + dx * t, y: a.y + dy * t }, forward, up: { x: forward.y, y: -forward.x }, size: torso };
}

/** The first `count` scars (SCAR_ORDER) on these landmarks, leaving out any whose face or limb can't be seen. */
export function scarsOn(l: readonly NormalizedLandmark[], count: number): Scar[] {
  const head = headOf(l);
  const torso = torsoLength(l as NormalizedLandmark[]);
  return SCAR_ORDER.slice(0, count).flatMap((kind) => {
    const scar = isFace(kind) ? (head ? faceScar(kind, head) : null) : bodyScar(kind, l, torso);
    return scar ? [scar] : [];
  });
}
