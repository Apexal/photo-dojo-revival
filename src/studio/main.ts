import QRCode from "qrcode";
import { strToU8, zipSync } from "fflate";
import { exportFighterFile, fighterFileName } from "../shared/fighter-codec";
import {
  MAX_SOUND_SECONDS,
  MAX_SOUND_TAKES,
  SOUND_IDS,
  createFighterId,
  tidyFighterName,
  type CapturedPose,
  type Fighter,
  type LimbSide,
  type NormalizedLandmark,
  type PoseId,
  type SoundId,
} from "../shared/fighter-model";
import { clearDraft, loadDraft, onDbBlocked, saveDraft, saveFighter, saveFighterWithSources } from "../shared/fighter-storage";
import { CAPTURE_TARGET_COUNT, captureTargetsFor, type PoseDefinition } from "../shared/pose-definitions";
import { compareStep, stepAdvice } from "../shared/walk-step";
import type { ArchetypeId } from "../shared/archetypes";
import { captureUrl } from "../shared/room-code";
import { canvasToPng, context2d, createCanvas, normalizeRect } from "../shared/canvas";
import { gateStudio, isTablet } from "../game/device-gate";
import { BackgroundRemover, type MatteDebug } from "../capture/background-remover";
import { assessCutout, cutoutAdvice, describeCutoutIssues, type CutoutQuality } from "../capture/cutout-quality";
import { GhostFitter, framingAdvice, type FramingAdvice } from "../capture/framing";
import { GhostOverlay } from "../capture/ghost-overlay";
import { HoldSound } from "../capture/hold-sound";
import { personCropRect } from "../capture/matting";
import { DEFAULT_MATCHER_OPTIONS, PoseMatcher, type MatcherUpdate } from "../capture/pose-matcher";
import { PoseCoach, checkStillPose, correctionArrows, type Correction, type CorrectionArrow } from "../capture/pose-coaching";
import { PoseTracker } from "../capture/pose-tracker";
import { BURST_FRAMES } from "../capture/sharpness";
import { SoundRecorder, playClip } from "../capture/sound-recorder";
import {
  cutoutFromCrop,
  makeThumbnail,
  planFighterSprites,
  renderSprite,
  toPixelLandmarks,
  type MaskedCapture,
  type PoseCaptureGeometry,
  type SpritePlan,
} from "../capture/sprite-normalizer";
import { DownloadTracker } from "../capture/vision-runtime";
import { VoicePrompts } from "../capture/voice-prompts";
import {
  DRAFT_VERSION,
  FIGHTER_SOURCES_VERSION,
  isResumable,
  summarizeDraft,
  type CaptureDraft,
  type DraftCapture,
  type FighterSources,
} from "./capture-draft";
import type { CameraSource, CameraStatus } from "./camera-source";
import { LocalCamera, listCameras, type CameraDevice } from "./local-camera";
import { PhoneHost } from "./phone-host";
import { RemoteCamera } from "./remote-camera";
import { asEditOf, editParam, loadEditSession, sessionPoses, sessionSounds } from "./edit-session";
import { GRACE_MS, initialStudioFlow, isLiveScreen, studioFlowReducer, targetAt, type StudioEvent, type StudioFlowState, type StudioScreen } from "./studio-flow";
import { downloadBlob } from "./ui/dom";
import { introPanel } from "./ui/intro";
import { cameraStatusText, loadStatusText, renderScreen, type CameraPanelEnv, type ScreenActions, type StudioSessionData } from "./ui/screens";

/**
 * The Character Studio (/studio): builds a fighter on this computer from a
 * camera, either its own (webcam, Continuity Camera) or a phone streaming
 * over WebRTC. Live pose tracking, auto-capture, background removal,
 * sprites, sounds on this computer's mic, preview, save to IndexedDB.
 * `?edit=<fighterId>` opens a saved fighter instead (edit-session.ts).
 * docs/character-studio.md.
 */

/** Everything captured so far in this session. */
interface SessionData extends StudioSessionData {
  fighterId: string;
  /** Main captures. */
  poses: Partial<Record<PoseId, CapturedPose>>;
  /** Second versions (uppercut, low kick, …), keyed by capture target ("punch-2"). */
  variants: Partial<Record<string, CapturedPose>>;
}

const FRAMING_HINTS: Record<Exclude<FramingAdvice, "ok">, string> = {
  closer: "Come a bit closer",
  further: "Step a bit further back",
  center: "Move toward the middle of the picture",
};
/** Still in the pose when the buffer between poses ends: they have to reset first, so the capture is deliberate. */
const BREAK_PROMPT = "Relax for a second, then strike the pose";
const FRAMING_VOICE = { settleMs: 1500, repeatMs: 5000 } as const;
/** "Hold still" when the hold starts over because they moved, at most this often. */
const HOLD_STILL_REPEAT_MS = 4000;
/** The photo can't be kept (out of the pose, or a rough cut-out): the pose again. `message` is shown, `spoken` said. */
class RetakeNeeded extends Error {
  constructor(message: string, readonly spoken: string) {
    super(message);
  }
}

/** Remembers that "How it works" was seen (this browser only; without storage it just shows again). */
const INTRO_SEEN_KEY = "photoDojo.studioIntroSeen";
function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === "1"; } catch { return false; }
}
function markIntroSeen(): void {
  try { localStorage.setItem(INTRO_SEEN_KEY, "1"); } catch { /* shows again next time */ }
}

/** `?debug=1`: keep raw frames and the matting stages so they can be exported for tuning. */
const DEBUG_MATTING = new URLSearchParams(location.search).has("debug");

const SITE = { origin: location.origin, base: import.meta.env.BASE_URL };

interface StoredCapture {
  cut: MaskedCapture;
  /** PNG of the cut-out, encoded once for the draft and the saved sources. */
  png?: Blob;
  geometry: PoseCaptureGeometry;
  capturedAt: number;
  attackSide?: LimbSide;
}

/** The signature pose of the style before a change, kept until the new one is captured. */
interface SetAsideSignature {
  capture?: StoredCapture;
  rendered?: { from: StoredCapture; scale: number };
  debug?: DebugCapture;
  pose?: CapturedPose;
  preview?: string;
}

interface LiveState {
  landmarks: ReturnType<PoseTracker["detectLive"]>;
  update: MatcherUpdate | null;
  framing: FramingAdvice | null;
  /** The one joint to fix, shown and spoken instead of the pose's prompt. */
  correction: Correction | null;
  /** Which way to move for the correction (frame pixels). */
  arrows: CorrectionArrow[];
}

interface DebugCapture {
  frame: HTMLCanvasElement | OffscreenCanvas;
  landmarks: NormalizedLandmark[];
  debug: MatteDebug;
  quality: CutoutQuality;
  /** Sharpness of each burst frame (the sharpest was used). */
  sharpness: number[];
}

const newSession = (): SessionData => ({
  fighterId: createFighterId(),
  name: "",
  poses: {},
  variants: {},
  previews: {},
  sounds: {},
});

/** Screens showing the camera panel: they redraw when the camera's state changes. */
const showsCameraPanel = (s: StudioScreen) => s.name === "setup" || s.name === "camera" || s.name === "cameraLost";

class StudioApp {
  private flow: StudioFlowState = initialStudioFlow();
  private data = newSession();
  /** The camera in use: this computer's, or the connected phone's. */
  private source: CameraSource | null = null;
  private offSourceStatus: (() => void) | null = null;
  private cameraChoice: "phone" | "local" | null = null;
  /** The room phones join; one code for the whole visit, made on the first "Use a phone". */
  private phoneHost: PhoneHost | null = null;
  private qrDataUrl: string | null = null;
  private cameras: CameraDevice[] = [];
  private canSwitchLocal = false;
  /** The last status line sent to the phone, so it's only sent on change. */
  private phoneStatus = "";
  private tracker: PoseTracker | null = null;
  private remover: BackgroundRemover | null = null;
  private recorder: SoundRecorder | null = null;
  private readonly voice = new VoicePrompts();
  private readonly holdSound = new HoldSound();
  private matcher: PoseMatcher | null = null;
  private stopFrames: (() => void) | null = null;
  private overlay: GhostOverlay | null = null;
  private live: LiveState = { landmarks: null, update: null, framing: null, correction: null, arrows: [] };
  private capturing = false;
  /** A phone still is on its way: the person keeps holding the pose. */
  private awaitingStill = false;
  /** Exposure and white balance are held for this fighter (after its first photo). */
  private exposureLocked = false;
  /** "How it works", in place of setup: the first visit (not when opening a fighter to edit), or asked for. */
  private intro: HTMLElement | null = null;
  private readonly ghostFitter = new GhostFitter();
  private holdStillSaidAt = -Infinity;
  private readonly coach = new PoseCoach();
  /** "A bit closer" / "further" is spoken once it's been true for a moment, and not too often. */
  private framingVoice: { advice: FramingAdvice; since: number; spokenAt: number } = { advice: "ok", since: 0, spokenAt: -Infinity };
  /** Model download progress, 0..1, for the loading screen. */
  private loadProgress = 0;
  private switchingCamera = false;
  private readonly debugCaptures = new Map<string, DebugCapture>();
  /** Cut-outs for every captured pose, so sprites can be re-rendered at the fighter-wide scale. */
  private readonly captures = new Map<string, StoredCapture>();
  /** The capture each sprite was rendered from, and at what scale: a retake (a new capture) always renders anew. */
  private renderedScale = new Map<string, { from: StoredCapture; scale: number }>();
  /** A change of style puts the old signature pose here: back if the retake is called off, gone once the new one is in. */
  private setAsideSignature: SetAsideSignature | null = null;
  /** A saved in-progress capture offered on the setup screen. */
  private pendingDraft: CaptureDraft | null = null;
  private modelsPromise: Promise<void> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** Shown on the current screen (e.g. why saving failed); cleared on the next screen. */
  private notice = "";
  /** The saved fighter being edited (as it was when opened); null for a new one. */
  private editing: Fighter | null = null;
  /** `?edit=`: the fighter is being read from storage (the setup screen waits). */
  private openingEdit = false;
  private readonly banner = document.createElement("div");

  constructor(private readonly root: HTMLElement) {
    this.banner.className = "banner";
    this.banner.hidden = true;
    document.body.prepend(this.banner);
    onDbBlocked(() => this.showBanner("Another Photo Dojo tab (an older version) is keeping the studio from saving. Close it, then carry on here."));
    // Leaving says bye, so the phone stops retrying and shows "The studio closed".
    addEventListener("pagehide", () => {
      this.source?.stop();
      this.phoneHost?.stop();
    });
    const editId = editParam(location.search);
    this.openingEdit = editId !== null;
    if (!editId && !introSeen()) this.intro = this.createIntro();
    this.render();
    void this.checkDraft();
    if (editId) void this.openEdit(editId);
    // The models download and build while the camera is being set up.
    void this.ensureModels().catch((err) => console.warn("[studio] models didn't load yet", err));
  }

  private showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.hidden = false;
  }

  // --- cameras ---------------------------------------------------------------------

  private usePhone(): void {
    if (this.cameraChoice === "phone" && this.phoneHost?.isRunning) return;
    this.cameraChoice = "phone";
    this.replaceSource(null);
    const host = (this.phoneHost ??= this.createPhoneHost());
    host.start();
    this.refreshCameraUi();
  }

  private createPhoneHost(): PhoneHost {
    const host = new PhoneHost();
    const url = captureUrl(host.roomCode, SITE);
    QRCode.toDataURL(url, { margin: 1, width: 280, color: { dark: "#121018", light: "#f3efe6" } }).then(
      (dataUrl) => { this.qrDataUrl = dataUrl; this.refreshCameraUi(); },
      (err) => console.warn("[studio] couldn't draw the QR code", err),
    );
    host.onStatus(() => this.refreshCameraUi());
    host.onPhone((link) => {
      if (this.cameraChoice !== "phone") return host.dropPhone(link);
      const camera = new RemoteCamera(link, { onStillProgress: (got, total) => this.showStillProgress(got, total) });
      console.info("[studio] phone connected");
      this.replaceSource(camera);
    });
    return host;
  }

  private async useLocal(deviceId: string | null): Promise<void> {
    const current = this.source;
    if (this.cameraChoice === "local" && current instanceof LocalCamera) {
      if (deviceId && deviceId !== current.currentDeviceId) await current.useCamera(deviceId);
      else if (current.status.kind === "lost") await current.start();
      return;
    }
    this.cameraChoice = "local";
    this.replaceSource(null);
    this.phoneHost?.stop();
    const camera = new LocalCamera(deviceId);
    this.replaceSource(camera);
    await camera.start();
  }

  private retryCamera(): void {
    // A new track meters afresh: the next photo locks it again.
    this.exposureLocked = false;
    if (this.source instanceof LocalCamera) void this.source.start();
  }

  /** Swaps the camera in use; the old one stops (a phone gets bye). */
  private replaceSource(next: CameraSource | null): void {
    const old = this.source;
    if (old === next) return;
    this.exposureLocked = false;
    this.offSourceStatus?.();
    this.offSourceStatus = null;
    this.stopFrames?.();
    this.stopFrames = null;
    this.source = next;
    old?.stop();
    if (!next) {
      this.dispatch({ type: "cameraLost" });
      this.refreshCameraUi();
      return;
    }
    this.phoneStatus = "";
    this.offSourceStatus = next.onStatus((st) => this.onSourceStatus(next, st));
  }

  private onSourceStatus(source: CameraSource, status: CameraStatus): void {
    if (source !== this.source) return;
    console.info(`[studio] ${source.kind} camera ${status.kind}${status.kind === "lost" ? `: ${status.reason}` : ""}`);
    if (status.kind === "ready") {
      if (source instanceof LocalCamera) {
        void Promise.all([listCameras(), source.canSwitch()]).then(([cameras, canSwitch]) => {
          this.cameras = cameras;
          this.canSwitchLocal = canSwitch;
          this.refreshCameraUi();
        });
      }
      this.dispatch({ type: "cameraReady" });
      // Back on a live screen with a (new) camera: frames from it.
      if (isLiveScreen(this.flow.screen) && !this.stopFrames) this.stopFrames = source.onFrame((now) => this.onFrame(now));
      this.sendPhoneStatus();
    } else if (status.kind === "lost") {
      this.stopFrames?.();
      this.stopFrames = null;
      // The phone's room reopens under the same code; the phone comes back by itself.
      if (source.kind === "phone") this.phoneHost?.dropPhone();
      this.dispatch({ type: "cameraLost" });
    }
    this.refreshCameraUi();
  }

  private cameraEnv(): CameraPanelEnv {
    const host = this.phoneHost;
    return {
      choice: this.cameraChoice,
      status: this.source?.status ?? null,
      video: this.source?.video ?? null,
      mirrored: this.source?.mirrored ?? false,
      phone: host && this.cameraChoice === "phone"
        ? { host: host.status, qrDataUrl: this.qrDataUrl, url: captureUrl(host.roomCode, SITE) }
        : null,
      cameras: this.cameras,
      deviceId: this.source instanceof LocalCamera ? this.source.currentDeviceId : null,
    };
  }

  private get canSwitchCamera(): boolean {
    const source = this.source;
    if (source instanceof RemoteCamera) return source.info?.canSwitch ?? false;
    return source instanceof LocalCamera && this.canSwitchLocal;
  }

  /** The camera panel redraws; on the live screen only its status line changes. */
  private refreshCameraUi(): void {
    if (showsCameraPanel(this.flow.screen)) return this.render();
    const line = this.root.querySelector<HTMLElement>("[data-camera-status]");
    if (line) line.textContent = cameraStatusText(this.cameraEnv());
  }

  /** The line under the phone's preview, so the person posing can read where they are. */
  private sendPhoneStatus(): void {
    const source = this.source;
    if (!(source instanceof RemoteCamera) || source.status.kind !== "ready") return;
    const text = this.phoneStatusText();
    if (text === this.phoneStatus) return;
    this.phoneStatus = text;
    source.sendStatus(text);
  }

  private phoneStatusText(): string {
    const s = this.flow.screen;
    switch (s.name) {
      case "setup":
      case "tips":
        return "Connected. Get ready in front of the camera!";
      case "loading":
        return "The studio is warming up…";
      case "pose":
        return `Pose ${s.poseIndex + 1}/${CAPTURE_TARGET_COUNT} — ${targetAt(s.poseIndex, this.flow.archetype).definition.label}`;
      case "captured":
        return this.awaitingStill ? "Hold it…" : "Got it!";
      case "archetype":
        return "Pick a fighting style on the studio screen";
      case "saved":
        return "Saved! Your fighter is in the game.";
      default:
        return "The studio is finishing your fighter";
    }
  }

  private showStillProgress(received: number, total: number): void {
    const hint = this.root.querySelector<HTMLElement>("[data-hud=hint]");
    if (hint && this.awaitingStill && total > 0) hint.textContent = `Hold it… taking the photo (${Math.round((received / total) * 100)}%)`;
  }

  // --- drafts ------------------------------------------------------------------------

  private async checkDraft(): Promise<void> {
    const draft = await loadDraft<unknown>().catch(() => undefined);
    if (!isResumable(draft)) return;
    this.pendingDraft = draft;
    if (this.flow.screen.name === "setup") this.render();
  }

  /** Save after each change (debounced); a reload then loses nothing. */
  private saveDraftSoon(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.saveDraftNow(), 400);
  }

  /** Saves run one after another, so they can't land out of order, and a discard waits for the one in flight. */
  private saving: Promise<void> = Promise.resolve();

  private saveDraftNow(): Promise<void> {
    this.draftTimer = null;
    this.saving = this.saving.then(() => this.writeDraft());
    return this.saving;
  }

  /** Every captured pose as stored in a draft (and in a saved fighter's sources). */
  private async draftCaptures(): Promise<DraftCapture[]> {
    const captures: DraftCapture[] = [];
    for (const [key, c] of this.captures) {
      c.png ??= await canvasToPng(c.cut.image);
      captures.push({
        key, cutPng: c.png, offsetX: c.cut.offsetX, offsetY: c.cut.offsetY, geometry: c.geometry, capturedAt: c.capturedAt,
        ...(c.attackSide ? { attackSide: c.attackSide } : {}),
      });
    }
    return captures;
  }

  private async writeDraft(): Promise<void> {
    // Edit sessions aren't drafted: the one draft is for a new fighter.
    if (this.editing || !this.captures.size || this.flow.screen.name === "saving" || this.flow.screen.name === "saved") return;
    const draft: CaptureDraft = {
      version: DRAFT_VERSION, savedAt: Date.now(), fighterId: this.data.fighterId, name: this.data.name,
      mode: this.flow.mode, archetype: this.flow.archetype, captures: await this.draftCaptures(), sounds: this.data.sounds,
    };
    await saveDraft(draft).catch((err) => console.warn("[draft] couldn't save", err));
  }

  private async discardDraft(): Promise<void> {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.pendingDraft = null;
    await this.saving;
    await clearDraft().catch(() => {});
  }

  /** Decoding a draft's cut-outs takes a moment; setup shows it and takes no other input meanwhile. */
  private resuming = false;

  private async resumeDraft(): Promise<void> {
    const draft = this.pendingDraft;
    if (!draft || this.resuming) return;
    this.resuming = true;
    this.render();
    try {
      await this.loadDraft(draft);
    } catch (err) {
      console.warn("[draft] couldn't resume", err);
      this.resetSession();
      await this.discardDraft();
      this.dispatch({ type: "fail", message: "Couldn't load the saved capture. Start over to capture a new fighter." });
    } finally {
      this.resuming = false;
    }
  }

  private async loadDraft(draft: CaptureDraft): Promise<void> {
    this.voice.unlock();
    this.holdSound.unlock();
    this.data.fighterId = draft.fighterId;
    this.data.name = draft.name;
    this.data.sounds = draft.sounds;
    await this.restoreCaptures(draft.captures);
    await this.renderSprites();
    this.pendingDraft = null;
    this.dispatch({ type: "resume", mode: draft.mode, archetype: draft.archetype, next: summarizeDraft(draft).next });
  }

  /** Decodes stored cut-outs (a draft's, or a saved fighter's sources) back into captures. */
  private async restoreCaptures(captures: DraftCapture[]): Promise<void> {
    for (const c of captures) {
      const bitmap = await createImageBitmap(c.cutPng);
      const image = createCanvas(bitmap.width, bitmap.height);
      context2d(image).drawImage(bitmap, 0, 0);
      bitmap.close();
      this.captures.set(c.key, {
        cut: { image, offsetX: c.offsetX, offsetY: c.offsetY }, png: c.cutPng, geometry: c.geometry, capturedAt: c.capturedAt,
        ...(c.attackSide ? { attackSide: c.attackSide } : {}),
      });
    }
  }

  // --- editing a saved fighter ---------------------------------------------------------

  /**
   * `?edit=<fighterId>`: the fighter's sprites and sounds into the session,
   * and its cut-outs when it has them (retakes then re-plan every sprite at
   * one scale, as while building it); then its review.
   */
  private async openEdit(fighterId: string): Promise<void> {
    try {
      const session = await loadEditSession(fighterId);
      if (!session) {
        console.warn(`[studio] no fighter ${fighterId} to edit`);
        return this.dispatch({ type: "fail", message: "That fighter isn't on this computer." });
      }
      const { fighter, sources } = session;
      this.editing = fighter;
      this.data.fighterId = fighter.fighterId;
      this.data.name = fighter.name;
      this.data.sounds = sessionSounds(fighter);
      if (sources) {
        await this.restoreCaptures(sources.captures);
        await this.renderSprites();
      } else {
        Object.assign(this.data, sessionPoses(fighter));
        for (const [key, pose] of [...Object.entries(this.data.poses), ...Object.entries(this.data.variants)]) {
          if (pose) this.data.previews[key] = URL.createObjectURL(pose.imageBlob);
        }
      }
      console.info(`[studio] editing ${fighter.name} (${fighter.fighterId}, ${sources ? "with" : "without"} sources)`);
      this.dispatch({ type: "startEdit", archetype: fighter.archetype, hasSources: sources !== null });
    } catch (err) {
      console.warn("[studio] couldn't open the fighter", err);
      this.resetSession();
      this.editing = null;
      this.dispatch({ type: "fail", message: `Couldn't open that fighter: ${(err as Error).message}` });
    } finally {
      this.openingEdit = false;
      if (this.flow.screen.name === "setup") this.render();
    }
  }

  /** A fighter without sources: its old sprites go, and all sixteen poses are taken again (name and sounds stay). */
  private recaptureAll(): void {
    this.forgetCaptures();
    this.dispatch({ type: "recaptureAll" });
  }

  /** Back to a new fighter: the address loses its `?edit=`, so a reload doesn't reopen the old one. */
  private leaveEdit(): void {
    if (!this.editing && !editParam(location.search)) return;
    this.editing = null;
    const url = new URL(location.href);
    url.searchParams.delete("edit");
    history.replaceState(null, "", url);
  }

  private dispatch(event: StudioEvent): void {
    const before = this.flow;
    this.flow = studioFlowReducer(this.flow, event);
    if (this.flow === before) return;
    // Same screen, other state (mode, camera ready): only the camera panel's screens show any of it.
    if (this.flow.screen === before.screen) {
      if (showsCameraPanel(this.flow.screen)) this.render();
      return;
    }
    this.onEnter(before);
  }

  /** Side effects when the screen changes. */
  private onEnter(previous: StudioFlowState): void {
    const s = this.flow.screen;
    const wasLive = isLiveScreen(previous.screen);
    const isLive = isLiveScreen(s);
    if (wasLive && !isLive) this.stopLive();
    if (!(s.name === "saving" && previous.screen.name === "preview")) this.notice = "";
    // The mic is only needed for the sounds.
    if (previous.screen.name === "sounds" && s.name !== "sounds") {
      this.recorder?.close();
      this.recorder = null;
    }
    if (s.name === "loading") {
      this.ensureModels().then(() => this.dispatch({ type: "modelsReady" }), (err) => this.failModels(err));
    }
    if (s.name === "pose") this.startPose(s.poseIndex);
    if (s.name === "archetype") this.voice.say("Pick your fighting style.");
    if (s.name === "cameraLost") this.voice.say(this.cameraChoice === "phone" ? "The phone disconnected." : "The camera stopped.");
    if (s.name === "sounds" && !SoundRecorder.isSupported()) return this.dispatch({ type: "skipAllSounds" });
    if (s.name === "saving") void this.save();
    this.sendPhoneStatus();
    // The live capture screen keeps its DOM; only its HUD updates.
    if (!(isLive && wasLive)) this.render();
    else this.renderHud();
  }

  private render(): void {
    renderScreen(this.root, this.flow, this.data, this.actions, {
      camera: this.cameraEnv(),
      loadProgress: this.loadProgress,
      canSwitchCamera: this.canSwitchCamera,
      onOverlay: (canvas) => { this.overlay = new GhostOverlay(canvas); },
      voiceEnabled: this.voice.enabled,
      voiceSupported: this.voice.supported,
      draft: this.pendingDraft ? summarizeDraft(this.pendingDraft) : null,
      resuming: this.resuming,
      debug: DEBUG_MATTING,
      notice: this.notice,
      gameUrl: `${import.meta.env.BASE_URL}?to=select`,
      tabletWarning: isTablet(),
      editing: this.editing !== null,
      openingEdit: this.openingEdit,
      intro: this.intro,
    });
    if (isLiveScreen(this.flow.screen)) this.renderHud();
  }

  private renderHud(): void {
    const s = this.flow.screen;
    if (!isLiveScreen(s)) return;
    const target = targetAt(s.poseIndex, this.flow.archetype);
    const def = target.definition;
    const step = this.root.querySelector<HTMLElement>("[data-hud=step]");
    const label = this.root.querySelector<HTMLElement>("[data-hud=label]");
    const hint = this.root.querySelector<HTMLElement>("[data-hud=hint]");
    if (step) step.textContent = `${s.poseIndex + 1} / ${CAPTURE_TARGET_COUNT}${s.retake ? " · retake" : ""}`;
    if (label) label.textContent = def.label;
    if (hint) hint.textContent = s.name === "captured" ? (this.awaitingStill ? "Hold it… taking the photo" : "Got it!") : this.hintText();
    const cutout = this.root.querySelector<HTMLImageElement>("[data-hud=cutout]");
    const url = this.data.previews[target.key];
    if (cutout) {
      cutout.hidden = s.name !== "captured" || !url || this.awaitingStill;
      if (url && cutout.src !== url) cutout.src = url;
    }
    // The strip's thumbnail of the pose just taken.
    const tile = this.root.querySelector<HTMLElement>(`.strip [data-key="${target.key}"]`);
    if (tile && url && tile.querySelector("img")?.src !== url) tile.firstElementChild?.replaceWith(Object.assign(document.createElement("img"), { src: url, alt: target.key }));
  }

  private hintText(): string {
    const s = this.flow.screen;
    if (s.name !== "pose") return "";
    const def = targetAt(s.poseIndex, this.flow.archetype).definition;
    const { landmarks, update, framing } = this.live;
    if (!landmarks) return "Step into the frame";
    const inFrame = update !== null && update.score !== Infinity;
    if (!inFrame) {
      return framing === "closer" ? "A bit closer — whole body in frame"
        : framing === "further" ? "A bit further back — head to feet in frame"
        : framing === "center" ? "Move toward the middle — all of you in the picture"
        : "Whole body in frame, please";
    }
    if (update.matching) return "Hold it…";
    if (update.awaitingBreak) return BREAK_PROMPT;
    // The pose's own instruction first, while it's being read out; then what to fix.
    return (update.armed && this.live.correction?.text) || def.voicePrompt;
  }

  // --- actions from the UI ------------------------------------------------------

  private readonly actions: ScreenActions = {
    selectMode: (mode) => this.dispatch({ type: "selectMode", mode }),
    resumeDraft: () => void this.resumeDraft(),
    discardDraft: () => void this.discardDraft().then(() => this.render()),
    setVoice: (enabled) => { this.voice.enabled = enabled; },
    usePhone: () => this.usePhone(),
    useLocal: (deviceId) => void this.useLocal(deviceId),
    retryCamera: () => this.retryCamera(),
    setupDone: () => {
      this.voice.unlock();
      this.holdSound.unlock();
      this.dispatch({ type: "setupDone" });
    },
    start: () => {
      this.voice.unlock();
      this.holdSound.unlock();
      this.dispatch({ type: "start" });
    },
    cancelCamera: () => {
      // Calling off a retake after a change of style: the old style's signature pose comes back with it.
      if (this.flow.screen.name === "camera" && this.flow.screen.previousArchetype) this.restoreSignature();
      this.dispatch({ type: "cancelCamera" });
    },
    switchCamera: () => void this.switchCamera(),
    retake: (targetKey) => this.dispatch({ type: "retake", targetKey }),
    pickArchetype: (archetype) => this.pickArchetype(archetype),
    changeArchetype: () => this.dispatch({ type: "changeArchetype" }),
    reviewDone: () => this.dispatch({ type: "reviewDone" }),
    recordSound: async (soundId, onLevel) => {
      const takes = (this.data.sounds[soundId] ??= []);
      if (takes.length >= MAX_SOUND_TAKES) return;
      try {
        this.recorder ??= await SoundRecorder.open();
        const clip = await this.recorder.record(MAX_SOUND_SECONDS[soundId] * 1000, onLevel);
        takes.push(clip);
        void playClip(clip);
        this.saveDraftSoon();
      } catch (err) {
        console.warn("[sound] recording failed", err);
      }
      this.render();
    },
    removeTake: (soundId, index) => {
      this.data.sounds[soundId]?.splice(index, 1);
      this.saveDraftSoon();
      this.render();
    },
    stopRecording: () => this.recorder?.stop(),
    playSound: (soundId, index) => void playClip(this.data.sounds[soundId]?.[index]),
    soundDone: () => this.dispatch({ type: "soundDone" }),
    skipSound: (soundId) => {
      this.data.sounds[soundId] = [];
      this.dispatch({ type: "skipSound" });
    },
    skipAllSounds: () => this.dispatch({ type: "skipAllSounds" }),
    setName: (name) => {
      this.data.name = name;
      this.saveDraftSoon();
    },
    finish: () => this.dispatch({ type: "finish" }),
    download: () => void this.download(),
    downloadDebug: () => void this.downloadDebug(),
    restart: () => {
      this.resetSession();
      // The stored draft belongs to a new fighter, not the one that was being edited: it stays on offer.
      if (this.editing || editParam(location.search)) this.leaveEdit();
      else void this.discardDraft();
      this.dispatch({ type: "restart" });
    },
    recaptureAll: () => this.recaptureAll(),
    openIntro: () => this.openIntro(),
  };

  /** Created once and re-attached on each render, so redraws don't restart it. */
  private createIntro(): HTMLElement {
    return introPanel({ base: import.meta.env.BASE_URL, onDone: () => this.closeIntro() });
  }

  private openIntro(): void {
    this.intro = this.createIntro();
    this.render();
  }

  private closeIntro(): void {
    markIntroSeen();
    this.intro = null;
    this.render();
  }

  /**
   * A different archetype means a different signature pose: the one captured
   * for the old one is set aside until the new one is in (backing out of the
   * camera screen brings it back), so an edit can't be left without one.
   */
  private pickArchetype(archetype: ArchetypeId): void {
    if (this.flow.archetype && this.flow.archetype !== archetype) {
      const key = "signature";
      // Only the first change's pose is worth keeping: a later one has nothing captured yet.
      if (!this.setAsideSignature) {
        this.setAsideSignature = {
          capture: this.captures.get(key), rendered: this.renderedScale.get(key), debug: this.debugCaptures.get(key),
          pose: this.data.poses.signature, preview: this.data.previews[key],
        };
      } else {
        const url = this.data.previews[key];
        if (url) URL.revokeObjectURL(url);
      }
      this.captures.delete(key);
      this.renderedScale.delete(key);
      this.debugCaptures.delete(key);
      delete this.data.poses.signature;
      delete this.data.previews[key];
    }
    this.dispatch({ type: "pickArchetype", archetype });
    this.saveDraftSoon();
  }

  /** The set-aside signature pose back in place (the change of style was called off). */
  private restoreSignature(): void {
    const kept = this.setAsideSignature;
    if (!kept) return;
    this.setAsideSignature = null;
    const key = "signature";
    const url = this.data.previews[key];
    if (url && url !== kept.preview) URL.revokeObjectURL(url);
    if (kept.capture) this.captures.set(key, kept.capture);
    if (kept.rendered) this.renderedScale.set(key, kept.rendered);
    if (kept.debug) this.debugCaptures.set(key, kept.debug);
    if (kept.pose) this.data.poses.signature = kept.pose;
    if (kept.preview) this.data.previews[key] = kept.preview;
    this.saveDraftSoon();
  }

  /** The new signature pose is in: the old one is gone for good. */
  private dropSetAsideSignature(): void {
    if (this.setAsideSignature?.preview) URL.revokeObjectURL(this.setAsideSignature.preview);
    this.setAsideSignature = null;
  }

  /** Forget everything captured (not the draft in storage). */
  private resetSession(): void {
    this.forgetCaptures();
    this.data = newSession();
  }

  /** Every pose (sprites, cut-outs, previews); the name and sounds stay. */
  private forgetCaptures(): void {
    this.dropSetAsideSignature();
    Object.values(this.data.previews).forEach((u) => u && URL.revokeObjectURL(u));
    this.data.poses = {};
    this.data.variants = {};
    this.data.previews = {};
    this.captures.clear();
    this.renderedScale.clear();
    this.debugCaptures.clear();
    if (this.exposureLocked) {
      this.exposureLocked = false;
      void this.source?.unlockExposure();
    }
  }

  // --- models + live tracking ----------------------------------------------------------

  /**
   * Pose and matting models, loaded once, from the moment the studio opens.
   * Downloads come first, with progress; the models are then built from the
   * model cache.
   */
  private ensureModels(): Promise<void> {
    this.modelsPromise ??= (async () => {
      // Estimated sizes until the real ones arrive, so the bar moves evenly. Each model is read once, by what uses it.
      const downloads = new DownloadTracker({ wasm: 13.5e6, pose: 30.7e6, ort: 28.3e6, matting: 178.6e6 }, (f) => this.setLoadProgress(f));
      // Everything downloads at once, but the matting session is built after the pose models (iPads: memory).
      const pose = this.tracker ? Promise.resolve(this.tracker) : PoseTracker.create(downloads.reporter("pose"), downloads.reporter("wasm"));
      const [tracker, remover] = await Promise.all([
        pose,
        this.remover ?? BackgroundRemover.create(downloads.reporter("matting"), downloads.reporter("ort"), pose),
      ]);
      this.setLoadProgress(1);
      this.tracker = tracker;
      this.remover = remover;
    })().catch((err) => {
      this.modelsPromise = null;
      throw err;
    });
    return this.modelsPromise;
  }

  private setLoadProgress(fraction: number): void {
    this.loadProgress = fraction;
    const bar = this.root.querySelector<HTMLElement>("[data-load-progress]");
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    const status = this.root.querySelector<HTMLElement>("[data-load-status]");
    if (status) status.textContent = loadStatusText(fraction);
  }

  private failModels(err: unknown): void {
    this.dispatch({ type: "fail", message: `Couldn't start the pose models: ${(err as Error).message}` });
  }

  private startPose(index: number): void {
    const def = targetAt(index, this.flow.archetype).definition;
    this.matcher = new PoseMatcher(def);
    this.matcher.start(performance.now());
    this.coach.start(performance.now());
    this.live = { landmarks: null, update: null, framing: null, correction: null, arrows: [] };
    this.voice.say(def.voicePrompt);
    if (!this.tracker) this.ensureModels().then(() => this.render(), (err) => this.failModels(err));
    if (!this.stopFrames && this.source) this.stopFrames = this.source.onFrame((now) => this.onFrame(now));
  }

  private stopLive(): void {
    this.holdSound.cancel();
    this.stopFrames?.();
    this.stopFrames = null;
  }

  private onFrame(now: number): void {
    const s = this.flow.screen;
    const source = this.source;
    if (!source || !this.tracker || !this.overlay || this.switchingCamera || !source.width || !isLiveScreen(s)) return;
    const W = source.width;
    const H = source.height;
    this.overlay.resize(W, H);
    const target = targetAt(s.poseIndex, this.flow.archetype);
    const def = target.definition;
    if (s.name === "pose" && this.matcher && !this.capturing && this.tracker.shouldDetect(now)) {
      // A phone's camera switch shows up in its camera-info, not as a new source.
      this.root.querySelector(".live")?.classList.toggle("mirrored", source.mirrored);
      const landmarks = this.tracker.detectLive(source.video, now);
      // Score in pixel space so angles aren't distorted by the frame's aspect ratio.
      const px = landmarks ? toPixelLandmarks(landmarks, W, H) : null;
      const framing = px ? framingAdvice(px, W, H) : null;
      // Framed so the photo would cut them off or be too small: the pose doesn't count (no hold, no "Got it" for a photo that can't pass).
      const update = this.matcher.update(framing === "ok" ? px : null, now);
      // The jump lifts the feet; keep the ghost on the floor.
      this.ghostFitter.update(px, W, H, now, { holdVertical: target.poseId === "jump" });
      // Coach only when the joints are the problem: not while framing advice (no score then), the break prompt or the hold is up.
      const coachable = !update.matching && !update.awaitingBreak && update.score !== Infinity;
      const coaching = this.coach.update(coachable ? update.joints : [], now);
      // Shown once the pose's own prompt has had its turn, like the hint.
      const fix = update.armed && coaching.correction && px ? update.joints.find((j) => j.joint === coaching.correction!.joint) : undefined;
      const arrows = fix?.delta != null && px ? correctionArrows(px, fix.joint, fix.delta) : [];
      this.live = { landmarks, update, framing, correction: coaching.correction, arrows };
      if (coaching.speak && coaching.correction) this.voice.say(coaching.correction.text, { interrupt: false });
      if (coaching.progress !== null) this.holdSound.progress(coaching.progress);
      if (update.events.includes("holdStarted")) {
        this.holdSound.start(DEFAULT_MATCHER_OPTIONS.holdMs);
        this.voice.say("Hold it");
      }
      if (update.events.includes("moved")) {
        this.holdSound.start(DEFAULT_MATCHER_OPTIONS.holdMs);
        if (now - this.holdStillSaidAt >= HOLD_STILL_REPEAT_MS) {
          this.holdStillSaidAt = now;
          this.voice.say("Hold still");
        }
      }
      if (update.events.includes("holdBroken")) this.holdSound.cancel();
      if (update.events.includes("breakNeeded")) this.voice.say(BREAK_PROMPT);
      if (update.events.includes("captured")) void this.capture();
      if (!update.matching) this.speakFraming(framing, now);
      this.renderHud();
    }
    this.overlay.draw({
      ghostPath: def.ghostSvgPath,
      ghostFit: this.ghostFitter.peek(W, H),
      landmarks: s.name === "pose" ? this.live.landmarks : null,
      joints: this.live.update?.joints ?? [],
      arrows: s.name === "pose" ? this.live.arrows : [],
      holdProgress: s.name === "captured" ? 1 : this.live.update?.holdProgress ?? 0,
      matching: s.name === "captured" || (this.live.update?.matching ?? false),
      large: this.flow.mode === "solo",
    });
  }

  /** Say "a bit closer" / "further back" once it's held for a moment, at most every few seconds. */
  private speakFraming(advice: FramingAdvice | null, now: number): void {
    const v = this.framingVoice;
    const current = advice ?? "ok";
    if (current !== v.advice) {
      v.advice = current;
      v.since = now;
      return;
    }
    if (current === "ok" || now - v.since < FRAMING_VOICE.settleMs || now - v.spokenAt < FRAMING_VOICE.repeatMs) return;
    v.spokenAt = now;
    this.voice.say(FRAMING_HINTS[current], { interrupt: false });
  }

  private async switchCamera(): Promise<void> {
    const source = this.source;
    if (!source || this.switchingCamera || this.capturing) return;
    this.switchingCamera = true;
    try {
      await source.switchCamera();
      this.exposureLocked = false;
    } catch (err) {
      console.warn("[camera] switch failed", err);
      this.toast("Couldn't switch camera");
    } finally {
      this.switchingCamera = false;
    }
    this.ghostFitter.reset();
    if (!isLiveScreen(this.flow.screen) || source !== this.source) return;
    // Re-render for the mirrored class and a fresh overlay; restart the frame loop on the new stream.
    this.render();
    this.stopFrames?.();
    this.stopFrames = source.onFrame((now) => this.onFrame(now));
  }

  /**
   * Grab the sharpest of a short burst at the camera's full resolution,
   * re-detect on the still, check it's in the pose, segment, check the cut-out,
   * normalize, store. Only a photo that passes both checks is kept: otherwise
   * the pose again, saying why. The person holds the pose until the photo is in
   * and in the pose ("Hold it…"), then hears "Got it".
   */
  private async capture(): Promise<void> {
    const s = this.flow.screen;
    const source = this.source;
    if (s.name !== "pose" || this.capturing || !this.tracker || !this.remover || source?.status.kind !== "ready") return;
    this.capturing = true;
    const remote = source.kind === "phone";
    const target = targetAt(s.poseIndex, this.flow.archetype);
    const liveLandmarks = this.live.landmarks;
    this.awaitingStill = true;
    this.dispatch({ type: "poseCaptured" });
    let graceDone = remote ? null : new Promise((r) => setTimeout(r, GRACE_MS[this.flow.mode]));
    try {
      // Judge sharpness on the person, not the (often blurry or flat) background.
      const { width: liveW, height: liveH } = source;
      const region = liveLandmarks ? normalizeRect(personCropRect(toPixelLandmarks(liveLandmarks, liveW, liveH), liveW, liveH), liveW, liveH) : null;
      const still = await source.grabStill(region, BURST_FRAMES).finally(() => {
        // From a phone, the grace before the next pose starts once the photo is in.
        if (remote) graceDone = new Promise((r) => setTimeout(r, GRACE_MS[this.flow.mode]));
      });
      const { frame, sharpness } = still;
      const W = frame.width;
      const H = frame.height;
      // Hitboxes, the matte and the sprite all come from the photo's own landmarks, never the live ones (another moment).
      const landmarks = this.tracker.detectStill(frame);
      if (!landmarks) throw new RetakeNeeded("Lost you in the photo: strike the pose again", "Let's try that again");
      const px = toPixelLandmarks(landmarks, W, H);
      const side = this.checkStillPose(target.key, px, target.definition);
      this.checkWalkPair(target.key, px, W);
      // The photo's in and in the pose: they can relax while it's cut out.
      this.awaitingStill = false;
      this.holdSound.complete();
      this.voice.say("Got it");
      if (remote) this.sendPhoneStatus();
      this.renderHud();
      const { foreground, debug } = await this.remover.cutout(frame, landmarks);
      console.info(`[capture] matting took ${debug.inferenceMs} ms on ${debug.backend} (${W}×${H} still)`);
      const quality = assessCutout({ alpha: debug.alpha, rect: debug.rect, frameWidth: W, frameHeight: H, landmarks: px });
      if (DEBUG_MATTING) this.debugCaptures.set(target.key, { frame, landmarks, debug, quality, sharpness });
      this.checkCutout(target.key, quality);
      this.captures.set(target.key, {
        cut: cutoutFromCrop(foreground, debug.rect),
        geometry: { poseId: target.poseId, landmarks, frameWidth: W, frameHeight: H },
        capturedAt: Date.now(),
        ...(target.definition.attackLimb ? { attackSide: side } : {}),
      });
      if (target.key === "signature") this.dropSetAsideSignature();
      if (!this.exposureLocked) void this.lockExposure(source);
      const plans = await this.renderSprites();
      this.saveDraftSoon();
      this.renderHud();
      if (plans[target.key]?.flipped) this.toast("Flipped so you face right");
      await graceDone;
      this.capturing = false;
      this.dispatch({ type: "graceElapsed" });
    } catch (err) {
      this.capturing = false;
      this.awaitingStill = false;
      this.holdSound.cancel();
      if (err instanceof RetakeNeeded) {
        this.toast(err.message);
        this.voice.say(err.spoken);
      } else {
        console.warn("[capture] failed", err);
        this.toast(`Didn't work (${(err as Error).message}). Try again.`);
        this.voice.say("Let's try that again");
      }
      await graceDone;
      this.dispatch({ type: "captureFailed" });
    }
  }

  /** The photo has to be in the pose: hitboxes come from its landmarks. Returns the limb it attacks with. */
  private checkStillPose(key: string, px: NormalizedLandmark[], def: PoseDefinition): LimbSide {
    const check = checkStillPose(px, def);
    if (check.ok) return check.side;
    console.info(`[capture] ${key}: photo out of the pose (score ${check.score.toFixed(2)})`);
    const fix = check.correction ?? "Strike the pose again";
    throw new RetakeNeeded(`Not quite in the photo: ${fix.toLowerCase()}`, `Not quite. ${fix}.`);
  }

  /**
   * The walk is drawn from the stance and the step together (walk-gait.ts):
   * taking either, it's compared with the other one if that's in. Same front
   * foot, and the step clearly wider (compareStep).
   */
  private checkWalkPair(key: string, px: NormalizedLandmark[], width: number): void {
    if (key !== "idle" && key !== "walk") return;
    const other = this.captures.get(key === "idle" ? "walk" : "idle")?.geometry;
    if (!other) return;
    const fresh = { landmarks: px, width };
    const stored = { landmarks: toPixelLandmarks(other.landmarks, other.frameWidth, other.frameHeight), width: other.frameWidth };
    const issue = key === "walk" ? compareStep(stored, fresh) : compareStep(fresh, stored);
    if (!issue) return;
    console.info(`[capture] ${key}: doesn't make a walk with the ${key === "walk" ? "stance" : "step"} (${issue})`);
    const advice = stepAdvice(issue, key === "walk" ? "step" : "stance");
    throw new RetakeNeeded(advice.shown, advice.spoken);
  }

  /** The cut-out has to be clean: a rough one is never kept. */
  private checkCutout(key: string, quality: CutoutQuality): void {
    if (!quality.issues.length) return;
    console.info("[capture] rough cut-out", key, quality);
    const advice = cutoutAdvice(quality);
    throw new RetakeNeeded(`Didn't cut out cleanly (${describeCutoutIssues(quality.issues)}). ${advice}`, `That one didn't cut out cleanly. ${advice}`);
  }

  /** After the fighter's first photo: hold the exposure and white balance from now on. */
  private async lockExposure(source: CameraSource): Promise<void> {
    this.exposureLocked = true;
    const locked = await source.lockExposure();
    console.info(locked.length ? `[camera] locked ${locked.join(", ")} for this fighter` : "[camera] this camera can't lock exposure or white balance");
  }

  /**
   * Plan all captured poses together (one scale for the fighter) and re-render
   * any sprite whose scale changed, e.g. when a new pose needs everything to
   * shrink a little to fit the canvas, and any pose captured anew (a retake).
   */
  private async renderSprites(): Promise<Record<string, SpritePlan>> {
    const plans = planFighterSprites(Object.fromEntries([...this.captures].map(([key, c]) => [key, c.geometry])));
    for (const [key, c] of this.captures) {
      const plan = plans[key];
      const previous = this.renderedScale.get(key);
      if (previous?.from === c && Math.abs(previous.scale - plan.transform.scale) <= 1e-6 * previous.scale) continue;
      const imageBlob = await renderSprite(c.cut, plan);
      this.renderedScale.set(key, { from: c, scale: plan.transform.scale });
      const pose: CapturedPose = {
        poseId: c.geometry.poseId,
        imageBlob,
        landmarks: plan.landmarks,
        anchorPoint: plan.anchorPoint,
        capturedAt: c.capturedAt,
        ...(c.attackSide ? { attackSide: c.attackSide } : {}),
      };
      if (key === c.geometry.poseId) this.data.poses[c.geometry.poseId] = pose;
      else this.data.variants[key] = pose;
      const old = this.data.previews[key];
      if (old) URL.revokeObjectURL(old);
      this.data.previews[key] = URL.createObjectURL(imageBlob);
    }
    return plans;
  }

  private toast(text: string): void {
    const host = this.root.querySelector(".viewport") ?? this.root;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    host.append(el);
    setTimeout(() => el.remove(), 2200);
  }

  // --- finish ------------------------------------------------------------------------

  private async buildFighter(): Promise<Fighter> {
    const archetype = this.flow.archetype;
    if (!archetype) throw new Error("No fighting style picked");
    const targets = captureTargetsFor(archetype);
    const missing = targets.filter((t) => !(t.variant ? this.data.variants[t.key] : this.data.poses[t.poseId])).map((t) => t.definition.label);
    if (missing.length) throw new Error(`Missing poses: ${missing.join(", ")}`);
    const poses = this.data.poses as Record<PoseId, CapturedPose>;
    const poseVariants: Partial<Record<PoseId, CapturedPose[]>> = {};
    for (const t of targets) {
      if (t.variant > 0) ((poseVariants[t.poseId] ??= [])[t.variant - 1] = this.data.variants[t.key]!);
    }
    const soundVariants: Partial<Record<SoundId, Blob[]>> = {};
    for (const id of SOUND_IDS) {
      const extra = (this.data.sounds[id] ?? []).slice(1);
      if (extra.length) soundVariants[id] = extra;
    }
    return {
      fighterId: this.data.fighterId,
      name: tidyFighterName(this.data.name) || "New Fighter",
      schemaVersion: 2,
      archetype,
      createdAt: Date.now(),
      facingDirection: "right",
      poses,
      sounds: Object.fromEntries(SOUND_IDS.map((id) => [id, this.data.sounds[id]?.[0] ?? null])) as Record<SoundId, Blob | null>,
      thumbnailBlob: await makeThumbnail(poses.idle.imageBlob),
      poseVariants,
      ...(Object.keys(soundVariants).length ? { soundVariants } : {}),
    };
  }

  /**
   * The fighter and its sources (the cut-outs, for retakes later) in one
   * write; then the draft goes. An edit saves over the fighter it opened (same
   * id and roster place, a fresh thumbnail and sources) and leaves the draft
   * alone; a fighter edited without sources is saved without any.
   */
  private async save(): Promise<void> {
    try {
      const built = await this.buildFighter();
      const original = this.editing;
      const fighter = original ? asEditOf(original, built) : built;
      if (this.flow.edit && !this.flow.edit.hasSources) {
        await saveFighter(fighter);
      } else {
        const sources: FighterSources = { version: FIGHTER_SOURCES_VERSION, fighterId: fighter.fighterId, captures: await this.draftCaptures(), savedAt: Date.now() };
        await saveFighterWithSources(fighter, sources);
      }
      if (original) this.editing = fighter;
      else await this.discardDraft(); // it's a real fighter now
      console.info(`[studio] saved ${fighter.name} (${fighter.fighterId}${original ? ", edited" : ""})`);
      this.dispatch({ type: "saved" });
    } catch (err) {
      console.warn("[studio] save failed", err);
      this.notice = `Couldn't save: ${(err as Error).message}`;
      this.dispatch({ type: "saveFailed" });
    }
  }

  /** Zip of raw frames + the matting stages, for checking background removal on real rooms. */
  private async downloadDebug(): Promise<void> {
    const files: Record<string, Uint8Array> = {};
    for (const [key, c] of this.debugCaptures) {
      const { rect, backend, inferenceMs, modelAlpha, alpha } = c.debug;
      const dir = `${key}/`;
      files[dir + "frame.png"] = new Uint8Array(await (await canvasToPng(c.frame)).arrayBuffer());
      files[dir + "info.json"] = strToU8(JSON.stringify(
        { rect, backend, inferenceMs, quality: c.quality, sharpness: c.sharpness, landmarks: c.landmarks }, null, 1));
      files[dir + "1-model-alpha.png"] = await grayPng(modelAlpha, rect.width, rect.height, 255);
      files[dir + "2-alpha.png"] = await grayPng(alpha, rect.width, rect.height, 1);
      const sprite = (this.data.poses[key as PoseId] ?? this.data.variants[key])?.imageBlob;
      if (sprite) files[dir + "3-sprite.png"] = new Uint8Array(await sprite.arrayBuffer());
    }
    downloadBlob(new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: "application/zip" }), "photodojo-matting-debug.zip");
  }

  /** The same fighter `save` writes (an edit keeps its `createdAt`; after a save, `editing` is the saved one). */
  private async download(): Promise<void> {
    const built = await this.buildFighter();
    const fighter = this.editing ? asEditOf(this.editing, built) : built;
    downloadBlob(await exportFighterFile(fighter), fighterFileName(fighter));
  }
}

async function grayPng(data: ArrayLike<number>, width: number, height: number, scale: number): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = data[i] * scale;
    img.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(await (await canvasToPng(canvas)).arrayBuffer());
}

const root = document.getElementById("app");
// Exposed for debugging from the console (and the e2e smoke test).
if (root) gateStudio(() => { (window as unknown as { photoDojoStudio: StudioApp }).photoDojoStudio = new StudioApp(root); });
