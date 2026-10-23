import type { ArchetypeId } from "../shared/archetypes";
import type { LimbSide, SoundId } from "../shared/fighter-model";
import { CAPTURE_KEYS } from "../shared/pose-definitions";
import type { CaptureMode } from "./capture-flow";
import type { PoseCaptureGeometry } from "./sprite-normalizer";

export const DRAFT_VERSION = 2;
/** Drafts older than this aren't offered for resuming. */
export const DRAFT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** One captured pose: the cut-out (PNG with alpha) plus what's needed to re-render its sprite. */
export interface DraftCapture {
  key: string;
  cutPng: Blob;
  offsetX: number;
  offsetY: number;
  geometry: PoseCaptureGeometry;
  capturedAt: number;
  attackSide?: LimbSide;
}

export interface CaptureDraft {
  version: typeof DRAFT_VERSION;
  savedAt: number;
  fighterId: string;
  name: string;
  mode: CaptureMode;
  roomCode: string | null;
  /** Null until it's picked (just before the signature pose). */
  archetype: ArchetypeId | null;
  captures: DraftCapture[];
  sounds: Partial<Record<SoundId, Blob[]>>;
}

/**
 * Where a resumed capture carries on: the first missing pose, as a retake
 * (back to the review afterwards) when it's the only one missing and poses
 * after it are in, e.g. a signature pose dropped by a change of archetype.
 */
export interface ResumePoint { poseIndex: number; retake: boolean }

export interface DraftSummary {
  captured: number;
  /** Null when all sixteen poses are in. */
  next: ResumePoint | null;
  ageMs: number;
}

export function summarizeDraft(draft: CaptureDraft, now = Date.now()): DraftSummary {
  const keys = new Set(draft.captures.map((c) => c.key));
  const missing = CAPTURE_KEYS.findIndex((k) => !keys.has(k));
  return {
    captured: CAPTURE_KEYS.filter((k) => keys.has(k)).length,
    next: missing < 0 ? null : { poseIndex: missing, retake: missing < CAPTURE_KEYS.length - 1 && CAPTURE_KEYS.slice(missing + 1).every((k) => keys.has(k)) },
    ageMs: now - draft.savedAt,
  };
}

/** Worth offering: recent, current format, and at least one pose captured. */
export function isResumable(draft: CaptureDraft | undefined, now = Date.now()): draft is CaptureDraft {
  return !!draft && draft.version === DRAFT_VERSION && draft.captures.length > 0 && now - draft.savedAt < DRAFT_MAX_AGE_MS;
}

export function describeAge(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
