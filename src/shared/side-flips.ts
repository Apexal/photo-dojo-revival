import { LANDMARK, LANDMARK_COUNT, type NormalizedLandmark } from "./fighter-model";

interface Point { x: number; y: number }
const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

/** Each landmark's mirror-side counterpart (MediaPipe numbering; the nose is its own). */
const MIRROR: readonly number[] = (() => {
  const m = Array.from({ length: LANDMARK_COUNT }, (_, i) => i);
  const pairs = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10]];
  for (let i = LANDMARK.leftShoulder; i < LANDMARK_COUNT; i += 2) pairs.push([i, i + 1]);
  for (const [a, b] of pairs) { m[a] = b; m[b] = a; }
  return m;
})();

/** The same landmarks with every left/right label swapped. */
export function swapSides(l: readonly NormalizedLandmark[]): NormalizedLandmark[] {
  return l.map((_, i) => ({ ...l[MIRROR[i]] }));
}

/** How much better the swapped pairing has to fit, for both shoulders and hips, to count as a flip. */
const FLIP_MARGIN = 0.6;

/**
 * MediaPipe sometimes labels a side-on body with left and right swapped. Its
 * signature is the whole torso fitting the other capture better swapped:
 * shoulders and hips both. One arm fitting better swapped is not a flip; a
 * cross (rear hand punching past the lead hand) does that for real.
 */
export function sidesFlipped(a: readonly NormalizedLandmark[], b: readonly NormalizedLandmark[]): boolean {
  const flippedPair = (left: number, right: number) => {
    const straight = dist(a[left], b[left]) + dist(a[right], b[right]);
    const swapped = dist(a[left], b[right]) + dist(a[right], b[left]);
    return swapped < FLIP_MARGIN * straight;
  };
  return flippedPair(LANDMARK.leftShoulder, LANDMARK.rightShoulder) && flippedPair(LANDMARK.leftHip, LANDMARK.rightHip);
}
