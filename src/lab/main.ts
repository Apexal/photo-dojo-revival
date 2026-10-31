import { BackgroundRemover, type MatteDebug, type MattingBackend } from "../capture/background-remover";
import { assessCutout, cutoutAdvice, QUALITY_THRESHOLDS, type CutoutQuality } from "../capture/cutout-quality";
import { GhostFitter, defaultGhostFit, fitGhost, framingAdvice } from "../capture/framing";
import { GhostOverlay } from "../capture/ghost-overlay";
import { CROP_MARGINS, REGION_ALPHA, applyAlpha, keepPerson, personCropRect, type CropMargins } from "../capture/matting";
import { correctionArrows, correctionFor, jointBand, unseenText, STILL_TOLERANCE_SLACK } from "../capture/pose-coaching";
import { DEFAULT_MATCHER_OPTIONS, PoseMatcher, type MatcherOptions } from "../capture/pose-matcher";
import { DEFAULT_POSE_TRACKER_OPTIONS, LIVE_DETECTION_HZ, PoseTracker, type PoseTrackerOptions } from "../capture/pose-tracker";
import { BURST_FRAMES } from "../capture/sharpness";
import { cutoutFromCrop, planSpriteNormalization, renderSprite, toPixelLandmarks } from "../capture/sprite-normalizer";
import { POSE_MODEL_URL } from "../capture/vision-runtime";
import { ARCHETYPES, ARCHETYPE_IDS, type ArchetypeId } from "../shared/archetypes";
import { canvasToPng, context2d, normalizeRect, type AnyCanvas } from "../shared/canvas";
import { LANDMARK, SPRITE_CANVAS_SIZE, type LandmarkName, type NormalizedLandmark } from "../shared/fighter-model";
import { captureTargetsFor } from "../shared/pose-definitions";
import {
  ANGLE_VISIBILITY_THRESHOLD,
  REQUIRED_VISIBILITY_THRESHOLD,
  computeJointAngles,
  evaluatePose,
  mirrorJointName,
  type JointName,
  type PoseEvaluation,
} from "../shared/pose-geometry";
import type { StickLimb } from "../shared/stick-figure";
import { LocalCamera, cameraErrorText, listCameras } from "../studio/local-camera";
import { downloadBlob, h } from "../studio/ui/dom";
import {
  defaultEdit,
  editKey,
  ghostSelfCheck,
  isModified,
  parseEdits,
  poseIdOf,
  specSnippet,
  stickFromLandmarks,
  stickSnippet,
  toDefinition,
  type PoseEdit,
} from "./pose-edits";

/**
 * The pose lab (/lab, dev only): the studio's capture pipeline with every knob out
 * in the open. Live pose scoring against an editable definition (exported as
 * code to paste into pose-definitions.ts / stick-figure.ts), the pose tracker's
 * and matcher's settings, and a snapshot's cut-out stage by stage.
 */

const POSE_MODELS = {
  heavy: POSE_MODEL_URL,
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
};
type PoseModel = keyof typeof POSE_MODELS;

const JOINTS: JointName[] = [
  "rightElbow", "leftElbow", "rightShoulderElevation", "leftShoulderElevation", "rightKnee", "leftKnee",
  "rightHipFlexion", "leftHipFlexion", "legSpread", "torsoLean", "headTilt",
];
const LANDMARK_NAMES = Object.keys(LANDMARK) as LandmarkName[];

interface LabSettings {
  archetype: ArchetypeId;
  key: string;
  cameraId: string | null;
  model: PoseModel;
  tracker: Omit<PoseTrackerOptions, "modelUrl">;
  liveHz: number;
  matcher: MatcherOptions;
  stillSlack: number;
  autoFreeze: boolean;
  burst: number;
  autoCutout: boolean;
  mattingBackend: "auto" | MattingBackend;
  fp16: boolean;
  margins: CropMargins;
  regionAlpha: number;
  keepConnected: boolean;
  showGhost: boolean;
  showDots: boolean;
}

const { modelUrl: _defaultModel, ...TRACKER_DEFAULTS } = DEFAULT_POSE_TRACKER_OPTIONS;

const DEFAULTS: LabSettings = {
  archetype: "brawler",
  key: "idle",
  cameraId: null,
  model: "heavy",
  tracker: TRACKER_DEFAULTS,
  liveHz: LIVE_DETECTION_HZ,
  matcher: DEFAULT_MATCHER_OPTIONS,
  stillSlack: STILL_TOLERANCE_SLACK,
  autoFreeze: false,
  burst: BURST_FRAMES,
  autoCutout: true,
  mattingBackend: "auto",
  fp16: true,
  margins: CROP_MARGINS,
  regionAlpha: REGION_ALPHA,
  keepConnected: true,
  showGhost: true,
  showDots: true,
};

const SETTINGS_KEY = "fotoFighterLab.settings";
const EDITS_KEY = "fotoFighterLab.edits";

function loadSettings(): LabSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<LabSettings>;
    return {
      ...DEFAULTS, ...saved,
      tracker: { ...DEFAULTS.tracker, ...saved.tracker },
      matcher: { ...DEFAULTS.matcher, ...saved.matcher },
      margins: { ...DEFAULTS.margins, ...saved.margins },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window or storage blocked: the lab works, it just forgets.
  }
}

function readEdits(): Record<string, PoseEdit> {
  try {
    return parseEdits(localStorage.getItem(EDITS_KEY));
  } catch {
    return {};
  }
}

const fmt = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits));
const bandClass = (error: number) => (Number.isFinite(error) ? jointBand(error) : "off");

/** A labelled slider with a number box beside it, both bound to one value. */
function slider(label: string, value: number, opts: { min: number; max: number; step: number; title?: string }, onChange: (v: number) => void): HTMLElement {
  const range = h("input", { type: "range", min: opts.min, max: opts.max, step: opts.step, value });
  const box = h("input", { type: "number", min: opts.min, max: opts.max, step: opts.step, value });
  const set = (source: HTMLInputElement, other: HTMLInputElement) => () => {
    const v = Number(source.value);
    if (!Number.isFinite(v)) return;
    other.value = String(v);
    onChange(v);
  };
  range.addEventListener("input", set(range, box));
  box.addEventListener("change", set(box, range));
  return h("label", { class: "field", title: opts.title ?? "" }, h("span", {}, label), range, box);
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, title = ""): HTMLElement {
  return h("label", { class: "check", title }, h("input", { type: "checkbox", checked, on: { change: (e) => onChange((e.target as HTMLInputElement).checked) } }), label);
}

function select<T extends string>(options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const el = h("select", { on: { change: () => onChange(el.value as T) } }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
  return el;
}

function grayInto(canvas: HTMLCanvasElement, data: ArrayLike<number>, width: number, height: number, scale: number): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = context2d(canvas);
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = data[i] * scale;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

interface Still { frame: AnyCanvas; sharpness: number[] | null; name: string }
interface Matte { still: Still; landmarks: NormalizedLandmark[]; debug: MatteDebug }

class LabApp {
  private settings = loadSettings();
  private edits = readEdits();

  private camera: LocalCamera | null = null;
  private stopFrames: (() => void) | null = null;
  private tracker: PoseTracker | null = null;
  private remover: BackgroundRemover | null = null;
  private removerDirty = false;

  private mode: "live" | "still" = "live";
  private still: Still | null = null;
  private landmarks: NormalizedLandmark[] | null = null;
  private evaluation: PoseEvaluation | null = null;
  private detectMs = 0;
  private matcher!: PoseMatcher;
  private readonly fitter = new GhostFitter();
  private freezing = false;
  private matte: Matte | null = null;
  private matteBusy = false;

  // The page's fixed parts.
  private readonly viewport = h("div", { class: "viewport" });
  private readonly stillCanvas = h("canvas");
  private readonly overlayCanvas = h("canvas");
  private readonly dotsCanvas = h("canvas");
  private readonly overlay = new GhostOverlay(this.overlayCanvas);
  private readonly badge = h("div", { class: "badge" });
  private readonly emptyNote = h("div", { class: "empty-note" }, "Starting the camera… or drop a photo here.");
  private readonly cameraSelect = h("select");
  private readonly freezeButton = h("button", { class: "primary" }, "Snapshot");
  private readonly liveButton = h("button", {}, "Back to live");
  private readonly status = h("span", { class: "muted" }, "Loading the pose model…");
  private readonly matteSection = h("section", { class: "matte" });
  private readonly editorBody = h("div");
  private readonly readoutBody = h("div");
  private readonly allPosesBody = h("tbody");
  private readonly jointsBody = h("tbody");
  private readonly landmarksBody = h("tbody");
  private readonly trackerButton = h("button", { on: { click: () => void this.loadTracker() } }, "Reload pose model");
  private readonly removerButton = h("button", { on: { click: () => void this.loadRemover() } }, "Reload matting model");

  // Live readouts, refreshed with every detection without rebuilding the editor (so inputs keep focus).
  private targetCells: { measured: HTMLElement; delta: HTMLElement; error: HTMLElement }[] = [];
  private ghostCheck = h("span");
  private ghostPreview: SVGPathElement | null = null;

  constructor(private readonly root: HTMLElement) {
    this.viewport.append(this.stillCanvas, this.overlayCanvas, this.dotsCanvas, this.emptyNote, this.badge);
    this.resetMatcher();
    this.root.append(this.stagePane(), this.sidePane());
    this.renderEditor();
    void this.loadTracker();
    void this.loadRemover();
    void this.startCamera();
  }

  // --- the definition being edited ----------------------------------------------------

  private get key(): string {
    return this.settings.key;
  }

  private get edit(): PoseEdit {
    const k = editKey(this.key, this.settings.archetype);
    return (this.edits[k] ??= defaultEdit(this.key, this.settings.archetype));
  }

  private editFor(key: string): PoseEdit {
    return this.edits[editKey(key, this.settings.archetype)] ?? defaultEdit(key, this.settings.archetype);
  }

  /** After any change to the definition. `structure`: rows were added or removed, rebuild the editor. */
  private edited(structure = false): void {
    store(EDITS_KEY, this.edits);
    if (structure) this.renderEditor();
    else this.refreshEditorBits();
    this.resetMatcher();
    this.evaluate(performance.now());
  }

  private saveSettings(): void {
    store(SETTINGS_KEY, this.settings);
  }

  private resetMatcher(): void {
    this.matcher = new PoseMatcher(toDefinition(this.edit, this.key), this.settings.matcher);
    this.matcher.start(performance.now());
  }

  // --- models ---------------------------------------------------------------------------

  private async loadTracker(): Promise<void> {
    const { model, tracker: options } = this.settings;
    this.trackerButton.disabled = true;
    this.setStatus(`Loading the ${model} pose model…`);
    try {
      const tracker = await PoseTracker.create(
        (loaded, total) => this.setStatus(`Pose model ${Math.round((100 * loaded) / (total || loaded || 1))}%`),
        undefined,
        { ...options, modelUrl: POSE_MODELS[model] },
      );
      this.tracker?.close();
      this.tracker = tracker;
      this.setTrackerDirty(false);
      this.setStatus(`Pose: ${model}, ${options.delegate} delegate`);
      if (this.mode === "still") this.detectStill();
    } catch (err) {
      console.warn("[lab] pose model", err);
      this.setStatus(`Pose model failed: ${(err as Error).message}`);
    } finally {
      this.trackerButton.disabled = false;
    }
  }

  private async loadRemover(): Promise<void> {
    this.removerButton.disabled = true;
    // One ISNet session at a time: they're a gigabyte or two each.
    this.remover?.close();
    this.remover = null;
    try {
      const { mattingBackend, fp16 } = this.settings;
      this.remover = await BackgroundRemover.create(undefined, undefined, undefined, {
        ...(mattingBackend === "auto" ? {} : { backend: mattingBackend }),
        fp16,
      });
      this.setRemoverDirty(false);
      this.renderMatte();
    } catch (err) {
      console.warn("[lab] matting model", err);
      this.matteSection.replaceChildren(h("p", { class: "error" }, `Matting model failed: ${(err as Error).message}. Built it? (CLAUDE.md: build-matting-model.py)`));
    } finally {
      this.removerButton.disabled = false;
    }
  }

  private setTrackerDirty(dirty: boolean): void {
    this.trackerButton.classList.toggle("dirty", dirty);
  }

  private setRemoverDirty(dirty: boolean): void {
    this.removerDirty = dirty;
    this.removerButton.classList.toggle("dirty", dirty);
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  // --- sources ----------------------------------------------------------------------------

  private async startCamera(deviceId = this.settings.cameraId): Promise<void> {
    this.stopCamera();
    const camera = new LocalCamera(deviceId);
    this.camera = camera;
    camera.video.addEventListener("loadedmetadata", () => this.evaluate(performance.now()));
    camera.onStatus((s) => {
      if (s.kind === "lost") this.emptyNote.textContent = `${s.reason} Drop a photo here instead.`;
      if (s.kind === "ready") void this.fillCameraList();
      this.showSource();
    });
    this.stopFrames = camera.onFrame((now) => this.onVideoFrame(now));
    this.viewport.prepend(camera.video);
    await camera.start();
  }

  private stopCamera(): void {
    this.stopFrames?.();
    this.stopFrames = null;
    this.camera?.video.remove();
    this.camera?.stop();
    this.camera = null;
  }

  private async fillCameraList(): Promise<void> {
    const cameras = await listCameras();
    const current = this.camera?.currentDeviceId ?? null;
    this.cameraSelect.replaceChildren(
      ...cameras.map((c) => h("option", { value: c.deviceId, selected: c.deviceId === current }, c.label)),
      h("option", { value: "", selected: !this.camera }, "No camera"),
    );
  }

  private onVideoFrame(now: number): void {
    const camera = this.camera;
    if (this.mode !== "live" || !this.tracker || !camera || camera.status.kind !== "ready") return;
    if (!this.tracker.shouldDetect(now, this.settings.liveHz)) return;
    const started = performance.now();
    this.landmarks = this.tracker.detectLive(camera.video, now);
    this.detectMs = this.detectMs * 0.8 + (performance.now() - started) * 0.2;
    this.evaluate(now);
  }

  private async freeze(): Promise<void> {
    const camera = this.camera;
    if (this.freezing || !camera || camera.status.kind !== "ready") return;
    this.freezing = true;
    try {
      const { width: w, height: h } = camera;
      const region = this.landmarks ? normalizeRect(personCropRect(toPixelLandmarks(this.landmarks, w, h), w, h), w, h) : null;
      const still = await camera.grabStill(region, this.settings.burst);
      this.setStill({ frame: still.frame, sharpness: still.sharpness, name: "snapshot" });
    } catch (err) {
      this.setStatus(`Snapshot failed: ${cameraErrorText(err)}`);
    } finally {
      this.freezing = false;
    }
  }

  private async loadFile(file: File): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file);
      const frame = document.createElement("canvas");
      frame.width = bitmap.width;
      frame.height = bitmap.height;
      context2d(frame).drawImage(bitmap, 0, 0);
      bitmap.close();
      this.setStill({ frame, sharpness: null, name: file.name });
    } catch (err) {
      this.setStatus(`Couldn't open ${file.name}: ${(err as Error).message}`);
    }
  }

  private setStill(still: Still): void {
    this.mode = "still";
    this.still = still;
    this.matte = null;
    this.stillCanvas.width = still.frame.width;
    this.stillCanvas.height = still.frame.height;
    context2d(this.stillCanvas).drawImage(still.frame as CanvasImageSource, 0, 0);
    this.showSource();
    this.detectStill();
    this.renderMatte();
    if (this.settings.autoCutout) void this.runCutout();
  }

  private detectStill(): void {
    if (!this.still || !this.tracker) return;
    const started = performance.now();
    this.landmarks = this.tracker.detectStill(this.still.frame);
    this.detectMs = performance.now() - started;
    this.evaluate(performance.now());
  }

  private backToLive(): void {
    this.mode = "live";
    this.still = null;
    this.landmarks = null;
    this.fitter.reset();
    this.resetMatcher();
    this.showSource();
    this.evaluate(performance.now());
  }

  private showSource(): void {
    const live = this.mode === "live";
    const ready = this.camera?.status.kind === "ready";
    if (this.camera) this.camera.video.hidden = !live;
    this.stillCanvas.hidden = live;
    this.emptyNote.hidden = !live || ready;
    this.viewport.classList.toggle("mirrored", live && !!this.camera?.mirrored);
    this.freezeButton.disabled = !ready;
    this.liveButton.hidden = live;
  }

  private frameSize(): { W: number; H: number } {
    if (this.mode === "still" && this.still) return { W: this.still.frame.width, H: this.still.frame.height };
    return { W: this.camera?.width ?? 0, H: this.camera?.height ?? 0 };
  }

  // --- scoring ----------------------------------------------------------------------------

  private evaluate(now: number): void {
    const { W, H } = this.frameSize();
    const live = this.mode === "live";
    const def = toDefinition(this.edit, this.key);
    const px = this.landmarks && W ? toPixelLandmarks(this.landmarks, W, H) : null;
    const { matcher: m, stillSlack } = this.settings;
    this.evaluation = px ? evaluatePose(px, def, live ? m.toleranceScale : stillSlack, live ? m.requiredVisibility : REQUIRED_VISIBILITY_THRESHOLD) : null;
    const score = this.evaluation?.score ?? Infinity;

    let holdProgress = 0;
    let state: string;
    if (live) {
      const u = this.matcher.update(px, now);
      holdProgress = u.holdProgress;
      state = u.captured ? "captured" : u.matching ? "holding" : u.awaitingBreak ? "waiting for a break" : u.armed ? "armed" : "arming";
      if (u.captured && this.settings.autoFreeze) void this.freeze();
    } else {
      state = score <= 1 ? "photo passes" : "photo fails";
    }
    const matching = live ? state === "holding" || state === "captured" : score <= 1;

    if (W) {
      const ghostFit = live
        ? this.fitter.update(px, W, H, now, { holdVertical: poseIdOf(this.key) === "jump" })
        : (px && fitGhost(px, H)) ?? defaultGhostFit(W, H);
      const worst = this.evaluation?.joints.filter((j) => j.delta !== null && j.error > 1).sort((a, b) => b.error - a.error)[0];
      this.overlay.resize(W, H);
      this.overlay.draw({
        ghostPath: this.settings.showGhost ? def.ghostSvgPath : "",
        ghostFit,
        landmarks: this.landmarks,
        joints: this.evaluation?.joints ?? [],
        arrows: px && worst ? correctionArrows(px, worst.joint, worst.delta!) : [],
        holdProgress,
        matching,
        large: false,
      });
      this.drawDots(px, W, H);
    }
    this.badge.textContent = [
      `${W}×${H}  ${live ? `live @ ${this.settings.liveHz} Hz` : this.still?.name ?? "still"}`,
      `detect ${fmt(this.detectMs, 1)} ms`,
      px ? `framing: ${framingAdvice(px, W, H)}` : "nobody",
    ].join("   ");
    this.refreshReadouts(px, state, holdProgress);
  }

  /** Every landmark, by how sure MediaPipe is; and the cut-out's crop. */
  private drawDots(px: NormalizedLandmark[] | null, W: number, H: number): void {
    const canvas = this.dotsCanvas;
    if (canvas.width !== W || canvas.height !== H) [canvas.width, canvas.height] = [W, H];
    const ctx = context2d(canvas);
    ctx.clearRect(0, 0, W, H);
    if (this.settings.showDots && px) {
      const r = Math.max(3, W / 300);
      for (const l of px) {
        ctx.fillStyle = l.visibility >= this.settings.matcher.requiredVisibility ? "#5be08a" : l.visibility >= ANGLE_VISIBILITY_THRESHOLD ? "#ffc83d" : "#ff5a47";
        ctx.beginPath();
        ctx.arc(l.x, l.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.mode === "still" && this.matte?.still === this.still) {
      const { rect } = this.matte.debug;
      ctx.strokeStyle = "#ff7ac0";
      ctx.lineWidth = Math.max(2, W / 400);
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
    }
  }

  private refreshReadouts(px: NormalizedLandmark[] | null, state: string, holdProgress: number): void {
    const e = this.evaluation;
    const side = e?.side ?? "right";

    // The verdict.
    const worst = e?.joints.filter((j) => j.delta !== null && j.error > 1).sort((a, b) => b.error - a.error)[0];
    const advice = !e ? "Nobody detected" : e.unseen.length ? unseenText(e.unseen) : worst ? correctionFor(worst.joint, worst.delta!) : "In the pose";
    const score = e?.score ?? Infinity;
    this.readoutBody.replaceChildren(
      h("div", { class: "row" },
        h("span", { class: `score ${Number.isFinite(score) ? bandClass(score) : "off"}` }, fmt(score, 2)),
        h("span", { class: "muted" }, `worst error (≤ 1 passes) · ${state}`)),
      h("div", { class: "holdbar" }, h("div", { style: `width: ${Math.round(holdProgress * 100)}%` })),
      h("dl", { class: "verdict" },
        h("dt", {}, "Side"), h("dd", {}, e ? `${side}${side === "left" ? " (mirrored)" : ""}` : "—"),
        h("dt", {}, "Coach says"), h("dd", {}, advice ?? "—"),
        h("dt", {}, "Unseen"), h("dd", {}, e?.unseen.join(", ") || "—"),
        h("dt", {}, "Matching"), h("dd", {}, this.mode === "live"
          ? `tolerance ×${this.settings.matcher.toleranceScale}, visibility ≥ ${this.settings.matcher.requiredVisibility}`
          : `photo: tolerance ×${this.settings.stillSlack}, visibility ≥ ${REQUIRED_VISIBILITY_THRESHOLD}`)),
    );

    // The targets' rows in the editor.
    e?.joints.forEach((j, i) => {
      const cells = this.targetCells[i];
      if (!cells) return;
      const target = this.edit.angleTargets[i];
      cells.measured.textContent = j.delta === null ? "—" : fmt(target.degrees + j.delta);
      cells.delta.textContent = j.delta === null ? "—" : `${j.delta > 0 ? "+" : ""}${fmt(j.delta)}`;
      cells.error.textContent = fmt(j.error, 2);
      cells.error.className = bandClass(j.error);
    });
    if (!e) for (const cells of this.targetCells) cells.measured.textContent = cells.delta.textContent = cells.error.textContent = "—";

    // Every joint, as the definition sees it (left and right swapped when it matched mirrored).
    const angles = px ? computeJointAngles(px) : null;
    this.jointsBody.replaceChildren(...JOINTS.map((joint) => {
      const measured = angles?.[side === "left" ? mirrorJointName(joint) : joint] ?? null;
      const targeted = this.edit.angleTargets.some((t) => t.joint === joint);
      return h("tr", {},
        h("td", {}, joint),
        h("td", {}, fmt(measured)),
        h("td", {}, targeted ? "targeted" : h("button", {
          disabled: measured === null,
          on: { click: () => { this.edit.angleTargets.push({ joint, degrees: Math.round(measured!), tolerance: 20 }); this.edited(true); } },
        }, "+ target")));
    }));

    // Every pose of this archetype against the same body: what else would this count as?
    const scores = captureTargetsFor(this.settings.archetype).map((t) => ({
      key: t.key,
      label: this.editFor(t.key).label,
      score: px ? evaluatePose(px, toDefinition(this.editFor(t.key), t.key), this.mode === "live" ? this.settings.matcher.toleranceScale : this.settings.stillSlack).score : Infinity,
    }));
    this.allPosesBody.replaceChildren(...scores.map((s) => h("tr", {
      class: `clickable${s.key === this.key ? " current" : ""}`,
      on: { click: () => this.selectTarget(s.key) },
    }, h("td", {}, s.key), h("td", {}, s.label), h("td", { class: Number.isFinite(s.score) ? bandClass(s.score) : "" }, fmt(s.score, 2)))));

    this.landmarksBody.replaceChildren(...LANDMARK_NAMES.map((name, i) => {
      const l = this.landmarks?.[i];
      const v = l?.visibility;
      const cls = v === undefined ? "" : v >= this.settings.matcher.requiredVisibility ? "good" : v >= ANGLE_VISIBILITY_THRESHOLD ? "close" : "off";
      return h("tr", {}, h("td", {}, `${i} ${name}`), h("td", {}, fmt(l?.x, 3)), h("td", {}, fmt(l?.y, 3)), h("td", { class: cls }, fmt(v, 2)));
    }));
  }

  // --- cut-out ------------------------------------------------------------------------------

  private async runCutout(): Promise<void> {
    const still = this.still;
    if (!still || !this.landmarks || !this.remover || this.matteBusy) {
      if (still && !this.landmarks) this.matteSection.replaceChildren(h("p", { class: "error" }, "Nobody detected in the photo: nothing to cut out."));
      return;
    }
    this.matteBusy = true;
    this.matteSection.replaceChildren(h("p", { class: "muted" }, `Cutting out on ${this.remover.backend}…`));
    try {
      const landmarks = this.landmarks;
      const { debug } = await this.remover.cutout(still.frame, landmarks, this.settings.margins);
      if (this.still === still) this.matte = { still, landmarks, debug };
    } catch (err) {
      console.warn("[lab] cut-out", err);
      this.matteSection.replaceChildren(h("p", { class: "error" }, `Cut-out failed: ${(err as Error).message}`));
      return;
    } finally {
      this.matteBusy = false;
    }
    this.renderMatte();
    this.evaluate(performance.now());
  }

  /** The matte's stages. Keeping only what's connected is redone here, so its settings apply without running the model again. */
  private renderMatte(): void {
    const matte = this.matte;
    if (!matte) {
      this.matteSection.replaceChildren(h("p", { class: "muted" },
        this.remover ? "Take a snapshot or drop a photo, then Cut out." : this.removerDirty ? "Reload the matting model." : "Loading the matting model…"));
      return;
    }
    const { still, landmarks, debug } = matte;
    const { rect, modelAlpha } = debug;
    const W = still.frame.width, H = still.frame.height;
    const px = toPixelLandmarks(landmarks, W, H);
    const crop = px.map((l) => ({ ...l, x: l.x - rect.x, y: l.y - rect.y }));
    const { regionAlpha, keepConnected } = this.settings;
    const alpha = keepConnected ? keepPerson(modelAlpha, rect.width, rect.height, crop, regionAlpha) : Uint8ClampedArray.from(modelAlpha, (v) => Math.round(v * 255));
    const foreground = applyAlpha(context2d(still.frame).getImageData(rect.x, rect.y, rect.width, rect.height).data, alpha);
    const quality = assessCutout({ alpha, rect, frameWidth: W, frameHeight: H, landmarks: px });

    const model = h("canvas"), final = h("canvas"), cut = h("canvas");
    grayInto(model, modelAlpha, rect.width, rect.height, 255);
    grayInto(final, alpha, rect.width, rect.height, 1);
    [cut.width, cut.height] = [rect.width, rect.height];
    context2d(cut).putImageData(new ImageData(foreground, rect.width, rect.height), 0, 0);

    const sprite = h("img", { alt: "" });
    const spriteBox = h("div", {}, sprite);
    let spriteNote = "";
    try {
      const plan = planSpriteNormalization(landmarks, poseIdOf(this.key), W, H);
      spriteNote = `scale ${fmt(plan.transform.scale, 3)}, fit ${fmt(plan.transform.fitScale, 2)}${plan.flipped ? ", flipped" : ""}`;
      void renderSprite(cutoutFromCrop(foreground, rect), plan).then((blob) => {
        sprite.src = URL.createObjectURL(blob);
        sprite.onload = () => URL.revokeObjectURL(sprite.src);
      });
      // The ghost where the game would expect the body.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${SPRITE_CANVAS_SIZE} ${SPRITE_CANVAS_SIZE}`);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", toDefinition(this.edit, this.key).ghostSvgPath);
      svg.append(path);
      if (this.settings.showGhost) spriteBox.append(svg);
    } catch (err) {
      spriteNote = `no sprite: ${(err as Error).message}`;
    }

    const figure = (caption: string, body: Node) => h("figure", {}, body instanceof HTMLDivElement ? body : h("div", {}, body), h("figcaption", {}, caption));
    this.matteSection.replaceChildren(
      h("div", { class: "images" },
        figure("Model alpha", model),
        figure(keepConnected ? `Kept (region ≥ ${regionAlpha})` : "Kept (all of it)", final),
        figure("Cut-out", cut),
        figure(`Sprite · ${spriteNote}`, spriteBox)),
      this.qualityReport(quality, debug),
    );
  }

  private qualityReport(q: CutoutQuality, debug: MatteDebug): HTMLElement {
    const T = QUALITY_THRESHOLDS;
    const advice = cutoutAdvice(q);
    const sharpness = this.matte?.still.sharpness;
    return h("dl", { class: "verdict" },
      h("dt", {}, "Model"), h("dd", {}, `ISNet ${this.remover?.fp16 ? "fp16" : "fp32"} on ${debug.backend}, ${debug.inferenceMs} ms`),
      h("dt", {}, "Crop"), h("dd", {}, `${debug.rect.width}×${debug.rect.height} at ${debug.rect.x},${debug.rect.y}`),
      h("dt", {}, "Issues"), h("dd", { class: q.issues.length ? "off" : "good" }, q.issues.join(", ") || "none"),
      h("dt", {}, "Core missing"), h("dd", { class: q.coreMissing > T.coreMissing ? "off" : "good" }, `${fmt(q.coreMissing * 100, 1)}% (max ${T.coreMissing * 100}%)${q.holesIn ? `, mostly the ${q.holesIn}` : ""}`),
      h("dt", {}, "Margin filled"), h("dd", { class: q.marginFilled > T.marginFilled ? "off" : "good" }, `${fmt(q.marginFilled * 100, 1)}% (max ${T.marginFilled * 100}%)`),
      h("dt", {}, "Cut off"), h("dd", {}, q.cutOff.join(", ") || "—", q.edges.length ? ` (${q.edges.join(", ")})` : ""),
      h("dt", {}, "Advice"), h("dd", {}, advice.shown || "—"),
      h("dt", {}, "Burst sharpness"), h("dd", {}, sharpness ? sharpness.map((s) => fmt(s)).join(" · ") : "— (a file)"),
    );
  }

  // --- layout ---------------------------------------------------------------------------------

  private stagePane(): HTMLElement {
    const file = h("input", { type: "file", accept: "image/*", hidden: true, on: { change: () => { const f = file.files?.[0]; if (f) void this.loadFile(f); file.value = ""; } } });
    this.cameraSelect.addEventListener("change", () => {
      this.settings.cameraId = this.cameraSelect.value || null;
      this.saveSettings();
      if (this.settings.cameraId) {
        void this.startCamera();
      } else {
        this.stopCamera();
        this.showSource();
      }
    });
    this.freezeButton.addEventListener("click", () => void this.freeze());
    this.liveButton.addEventListener("click", () => this.backToLive());
    this.viewport.addEventListener("dragover", (e) => { e.preventDefault(); this.viewport.classList.add("dragging"); });
    this.viewport.addEventListener("dragleave", () => this.viewport.classList.remove("dragging"));
    this.viewport.addEventListener("drop", (e) => {
      e.preventDefault();
      this.viewport.classList.remove("dragging");
      const f = e.dataTransfer?.files[0];
      if (f) void this.loadFile(f);
    });
    const redraw = () => this.evaluate(performance.now());
    return h("div", { class: "stage" },
      h("div", { class: "toolbar" },
        this.cameraSelect,
        this.freezeButton,
        this.liveButton,
        h("button", { on: { click: () => file.click() } }, "Open photo…"), file,
        h("button", { on: { click: () => void this.runCutout() } }, "Cut out"),
        h("button", { on: { click: () => void this.saveStill() } }, "Save photo"),
        h("span", { class: "spacer" }),
        checkbox("Ghost", this.settings.showGhost, (v) => { this.settings.showGhost = v; this.saveSettings(); redraw(); this.renderMatte(); }),
        checkbox("Landmarks", this.settings.showDots, (v) => { this.settings.showDots = v; this.saveSettings(); redraw(); }),
        this.status),
      this.viewport,
      this.matteSection,
    );
  }

  private async saveStill(): Promise<void> {
    if (!this.still) return this.setStatus("Take a snapshot first");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob(await canvasToPng(this.still.frame), `pose-lab-${this.key}-${stamp}.png`);
  }

  private sidePane(): HTMLElement {
    const s = this.settings;
    const archetypeSelect = select(ARCHETYPE_IDS.map((id) => [id, ARCHETYPES[id].name] as const), s.archetype, (v) => {
      s.archetype = v;
      this.saveSettings();
      this.selectTarget(this.key);
    });
    const tracker = (patch: Partial<LabSettings["tracker"]>) => { Object.assign(s.tracker, patch); this.saveSettings(); this.setTrackerDirty(true); };
    const matcher = (patch: Partial<MatcherOptions>) => { Object.assign(s.matcher, patch); this.saveSettings(); this.resetMatcher(); this.evaluate(performance.now()); };
    const matting = (patch: Partial<LabSettings>) => { Object.assign(s, patch); this.saveSettings(); this.setRemoverDirty(true); };
    const keep = (patch: Partial<LabSettings>) => { Object.assign(s, patch); this.saveSettings(); this.renderMatte(); };

    return h("aside", { class: "side" },
      h("details", { open: true },
        h("summary", {}, "Pose"),
        h("div", { class: "row" }, archetypeSelect, h("span", { class: "hint" }, "the archetype picks the signature pose")),
        this.readoutBody),
      h("details", { open: true },
        h("summary", {}, "Definition"),
        this.editorBody),
      h("details", {},
        h("summary", {}, "All poses against this body"),
        h("p", { class: "hint" }, "Each capture target's score for the same landmarks: two passing at once means one could capture as the other. Click to edit."),
        h("table", { class: "data" }, h("thead", {}, h("tr", {}, h("th", {}, "Key"), h("th", {}, "Pose"), h("th", {}, "Score"))), this.allPosesBody)),
      h("details", {},
        h("summary", {}, "Every joint angle"),
        h("p", { class: "hint" }, "As the definition sees them: left and right swapped when the pose matched mirrored."),
        h("table", { class: "data" }, h("thead", {}, h("tr", {}, h("th", {}, "Joint"), h("th", {}, "Degrees"), h("th", {}))), this.jointsBody)),
      h("details", {},
        h("summary", {}, "Pose detection"),
        h("div", { class: "row" },
          h("span", {}, "Model"),
          select([["heavy", "Heavy (the studio's)"], ["full", "Full"], ["lite", "Lite"]] as const, s.model, (v) => { s.model = v; this.saveSettings(); this.setTrackerDirty(true); }),
          select([["auto", "GPU, else CPU"], ["GPU", "GPU"], ["CPU", "CPU"]] as const, s.tracker.delegate, (v) => tracker({ delegate: v }))),
        slider("Detection confidence", s.tracker.minPoseDetectionConfidence, { min: 0, max: 1, step: 0.05, title: "minPoseDetectionConfidence" }, (v) => tracker({ minPoseDetectionConfidence: v })),
        slider("Presence confidence", s.tracker.minPosePresenceConfidence, { min: 0, max: 1, step: 0.05, title: "minPosePresenceConfidence" }, (v) => tracker({ minPosePresenceConfidence: v })),
        slider("Tracking confidence", s.tracker.minTrackingConfidence, { min: 0, max: 1, step: 0.05, title: "minTrackingConfidence (live video only)" }, (v) => tracker({ minTrackingConfidence: v })),
        this.trackerButton,
        slider("Live detection, Hz", s.liveHz, { min: 1, max: 60, step: 1, title: "LIVE_DETECTION_HZ" }, (v) => { s.liveHz = v; this.saveSettings(); })),
      h("details", {},
        h("summary", {}, "Matching"),
        h("p", { class: "hint" }, "Live: the matcher (auto-capture). Photo: the check a snapshot has to pass (checkStillPose)."),
        slider("Live tolerance ×", s.matcher.toleranceScale, { min: 0.25, max: 3, step: 0.05 }, (v) => matcher({ toleranceScale: v })),
        slider("Live visibility ≥", s.matcher.requiredVisibility, { min: 0, max: 1, step: 0.05, title: "REQUIRED_VISIBILITY_THRESHOLD + LIVE_VISIBILITY_MARGIN" }, (v) => matcher({ requiredVisibility: v })),
        slider("Hold, ms", s.matcher.holdMs, { min: 0, max: 3000, step: 50 }, (v) => matcher({ holdMs: v })),
        slider("Arm after, ms", s.matcher.armAfterMs, { min: 0, max: 5000, step: 100 }, (v) => matcher({ armAfterMs: v })),
        checkbox("Needs a break out of the pose first", s.matcher.requireBreak, (v) => matcher({ requireBreak: v })),
        slider("Photo tolerance ×", s.stillSlack, { min: 0.25, max: 3, step: 0.05, title: "STILL_TOLERANCE_SLACK" }, (v) => { s.stillSlack = v; this.saveSettings(); this.evaluate(performance.now()); }),
        slider("Burst frames", s.burst, { min: 1, max: 12, step: 1, title: "BURST_FRAMES: the sharpest is kept" }, (v) => { s.burst = v; this.saveSettings(); }),
        h("div", { class: "row" },
          checkbox("Snapshot on capture", s.autoFreeze, (v) => { s.autoFreeze = v; this.saveSettings(); }, "When the hold completes, take the photo as the studio would"),
          h("button", { on: { click: () => { this.resetMatcher(); this.evaluate(performance.now()); } } }, "Restart hold"))),
      h("details", {},
        h("summary", {}, "Background removal"),
        h("div", { class: "row" },
          select([["auto", "WebGPU, else WASM"], ["webgpu", "WebGPU"], ["wasm", "WASM"]] as const, s.mattingBackend, (v) => matting({ mattingBackend: v })),
          checkbox("fp16 on WebGPU", s.fp16, (v) => matting({ fp16: v }))),
        this.removerButton,
        h("p", { class: "hint" }, "Crop margins (torso lengths) need Cut out again; the rest applies at once."),
        slider("Crop side", s.margins.side, { min: 0, max: 2, step: 0.05 }, (v) => { s.margins.side = v; this.saveSettings(); }),
        slider("Crop top", s.margins.top, { min: 0, max: 2, step: 0.05 }, (v) => { s.margins.top = v; this.saveSettings(); }),
        slider("Crop bottom", s.margins.bottom, { min: 0, max: 2, step: 0.05 }, (v) => { s.margins.bottom = v; this.saveSettings(); }),
        checkbox("Keep only what's connected to the skeleton", s.keepConnected, (v) => keep({ keepConnected: v })),
        slider("Region alpha ≥", s.regionAlpha, { min: 0.01, max: 0.9, step: 0.01, title: "REGION_ALPHA" }, (v) => keep({ regionAlpha: v })),
        checkbox("Cut out every snapshot", s.autoCutout, (v) => { s.autoCutout = v; this.saveSettings(); })),
      h("details", {},
        h("summary", {}, "Landmarks"),
        h("table", { class: "data" }, h("thead", {}, h("tr", {}, h("th", {}, "Landmark"), h("th", {}, "x"), h("th", {}, "y"), h("th", {}, "Visibility"))), this.landmarksBody)),
      h("details", {},
        h("summary", {}, "Lab"),
        h("button", { on: { click: () => { store(SETTINGS_KEY, {}); location.reload(); } } }, "Reset every setting"),
        " ",
        h("button", { class: "danger", on: { click: () => { this.edits = {}; this.edited(true); } } }, "Discard every pose edit")),
    );
  }

  private selectTarget(key: string): void {
    this.settings.key = key;
    this.saveSettings();
    this.renderEditor();
    this.resetMatcher();
    this.evaluate(performance.now());
    if (this.matte) this.renderMatte();
  }

  // --- the definition editor ---------------------------------------------------------------

  private renderEditor(): void {
    const { archetype } = this.settings;
    const edit = this.edit;
    const targets = captureTargetsFor(archetype);
    const modified = (key: string) => {
      const saved = this.edits[editKey(key, archetype)];
      return saved ? isModified(saved, key, archetype) : false;
    };

    const targetSelect = select(targets.map((t) => [t.key, `${modified(t.key) ? "● " : ""}${t.key} — ${this.editFor(t.key).label}`] as const), this.key, (v) => this.selectTarget(v));

    this.targetCells = [];
    const rows = edit.angleTargets.map((t, i) => {
      const cells = { measured: h("td", {}, "—"), delta: h("td", {}, "—"), error: h("td", {}, "—") };
      this.targetCells.push(cells);
      const number = (field: "degrees" | "tolerance", min: number, max: number) =>
        h("input", { type: "number", min, max, step: 1, value: t[field], on: { change: (e) => { t[field] = Number((e.target as HTMLInputElement).value); this.edited(); } } });
      return h("tr", {},
        h("td", {}, select(JOINTS.map((j) => [j, j] as const), t.joint, (v) => { t.joint = v; this.edited(); })),
        h("td", {}, number("degrees", 0, 180)),
        h("td", {}, number("tolerance", 1, 90)),
        cells.measured, cells.delta, cells.error,
        h("td", { class: "actions" },
          h("button", { title: "Target the angle measured now", on: { click: () => {
            const j = this.evaluation?.joints[i];
            if (j?.delta === null || j?.delta === undefined) return;
            t.degrees = Math.round(t.degrees + j.delta);
            this.edited(true);
          } } }, "= now"),
          h("button", { title: "Remove", on: { click: () => { edit.angleTargets.splice(i, 1); this.edited(true); } } }, "×")));
    });

    const required = h("div", { class: "landmarks" }, ...LANDMARK_NAMES.map((name) => checkbox(name, edit.requiredVisibleLandmarks.includes(name), (on) => {
      edit.requiredVisibleLandmarks = on ? [...edit.requiredVisibleLandmarks, name] : edit.requiredVisibleLandmarks.filter((n) => n !== name);
      this.edited();
    })));

    const specOut = h("pre", { class: "snippet", hidden: true });
    const show = (text: string) => {
      specOut.textContent = text;
      specOut.hidden = false;
      void navigator.clipboard?.writeText(text).then(() => this.setStatus("Copied"), () => {});
    };
    const file = this.key === "signature" ? "SIGNATURE_SPECS" : this.key.includes("-") ? "ALTERNATE_SPECS" : "SPECS";
    const stickTable = this.key === "signature" ? "STICK_SIGNATURE_POSES" : this.key.includes("-") ? "STICK_BONUS_POSES" : "STICK_POSES";

    this.editorBody.replaceChildren(
      h("div", { class: "row" }, targetSelect,
        h("button", { on: { click: () => { delete this.edits[editKey(this.key, archetype)]; this.edited(true); } } }, "Reset to the code's")),
      h("label", { class: "field" }, h("span", {}, "Label"),
        h("input", { type: "text", value: edit.label, on: { change: (e) => { edit.label = (e.target as HTMLInputElement).value; this.edited(true); } } }), h("span")),
      h("textarea", { rows: 2, value: edit.voicePrompt, on: { change: (e) => { edit.voicePrompt = (e.target as HTMLTextAreaElement).value; this.edited(); } } }),
      h("table", { class: "data" },
        h("thead", {}, h("tr", {}, ...["Joint", "Target", "± Tol", "Now", "Δ", "Error", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...rows)),
      h("div", { class: "row" },
        h("button", { on: { click: () => { edit.angleTargets.push({ joint: "rightElbow", degrees: 90, tolerance: 25 }); this.edited(true); } } }, "+ Angle target"),
        h("span", { class: "hint" }, "written for the right side; either side matches")),
      h("div", { class: "row" }, h("span", {}, "Attack limb"),
        select([["", "none"], ["arm", "arm"], ["leg", "leg"]] as const, edit.attackLimb ?? "", (v) => {
          if (v) edit.attackLimb = v;
          else delete edit.attackLimb;
          this.edited();
        })),
      h("details", {}, h("summary", {}, "Required landmarks"), required),
      h("details", { open: true }, h("summary", {}, "Ghost"), this.stickEditor()),
      h("div", { class: "row" },
        h("button", { on: { click: () => show(specSnippet(edit, this.key, archetype)) } }, `Copy for ${file}`),
        h("button", { on: { click: () => show(stickSnippet(edit, this.key, archetype)) } }, `Copy for ${stickTable}`)),
      h("p", { class: "hint" }, "Paste over the entry in src/shared/pose-definitions.ts / stick-figure.ts. Comments aren't kept; tests/lab-pose-edits.test.ts checks every ghost passes its own pose."),
      specOut,
    );
    this.refreshEditorBits();
  }

  private stickEditor(): HTMLElement {
    const stick = this.edit.stick;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${SPRITE_CANVAS_SIZE} ${SPRITE_CANVAS_SIZE}`);
    this.ghostPreview = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(this.ghostPreview);
    const angle = (label: string, get: () => number, set: (v: number) => void, min = -180, max = 180) =>
      slider(label, get(), { min, max, step: 1 }, (v) => { set(v); this.edited(); });
    const limb = (label: string, l: StickLimb) => [
      angle(`${label} swing`, () => l.swing, (v) => { l.swing = v; }),
      angle(`${label} bend`, () => l.bend, (v) => { l.bend = v; }, 0, 220),
    ];
    return h("div", {},
      h("div", { class: "stick" },
        h("div", {},
          angle("Torso lean", () => stick.torsoLean, (v) => { stick.torsoLean = v; }, -90, 90),
          angle("Head tilt", () => stick.headTilt, (v) => { stick.headTilt = v; }, -90, 90),
          ...limb("Right arm", stick.arms.right), ...limb("Left arm", stick.arms.left),
          ...limb("Right leg", stick.legs.right), ...limb("Left leg", stick.legs.left)),
        svg),
      h("div", { class: "row" },
        h("button", { title: "The ghost from the pose struck now (right = the side it matched on)", on: { click: () => {
          const { W, H } = this.frameSize();
          if (!this.landmarks || !W) return this.setStatus("Nobody to copy the ghost from");
          this.edit.stick = stickFromLandmarks(toPixelLandmarks(this.landmarks, W, H), this.evaluation?.side ?? "right");
          this.edited(true);
        } } }, "Ghost from the pose now"),
        this.ghostCheck),
      h("p", { class: "hint" }, "Swing: from straight down along the torso, forward positive. Bend: the elbow/knee angle (180 straight). The right limbs are the near side, the ones the definition targets."),
    );
  }

  /** The ghost preview and its check against its own definition (no rebuild: sliders keep focus). */
  private refreshEditorBits(): void {
    const def = toDefinition(this.edit, this.key);
    this.ghostPreview?.setAttribute("d", def.ghostSvgPath);
    const check = ghostSelfCheck(this.edit, this.key);
    this.ghostCheck.textContent = check.score <= 1 ? `Ghost passes (${fmt(check.score, 2)})` : `Ghost fails its own pose (${fmt(check.score, 2)})`;
    this.ghostCheck.className = check.score <= 1 ? "good" : "off";
  }
}

const root = document.getElementById("lab");
// Exposed for poking at from the console.
if (root) (window as unknown as { poseLab: LabApp }).poseLab = new LabApp(root);
