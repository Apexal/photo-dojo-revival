import { exportFighterFile, fighterFileName } from "../shared/fighter-codec";
import {
  MAX_SOUND_TAKES,
  SOUND_IDS,
  createFighterId,
  type CapturedPose,
  type Fighter,
  type LimbSide,
  type NormalizedLandmark,
  type PoseId,
  type SoundId,
} from "../shared/fighter-model";
import { clearDraft, loadDraft, saveDraft, saveFighter } from "../shared/fighter-storage";
import { DRAFT_VERSION, isResumable, summarizeDraft, type CaptureDraft, type DraftCapture } from "./capture-draft";
import { GameLink } from "./game-link";
import { CAPTURE_TARGETS } from "../shared/pose-definitions";
import { normalizeRoomCode } from "../shared/room-code";
import { connectAsGuest, fetchIceServers, type PeerLink } from "../transfer/peer-connection";
import { sendFighter } from "../transfer/fighter-sender";
import { SignalingClient } from "../transfer/signaling-client";
import { BackgroundRemover, type MatteDebug } from "./background-remover";
import { CameraSession } from "./camera-session";
import { assessCutout, describeCutoutIssues, type CutoutQuality } from "./cutout-quality";
import { GhostFitter, framingAdvice, type FramingAdvice } from "./framing";
import { personCropRect } from "./matting";
import { BURST_FRAMES } from "./sharpness";
import {
  DownloadTracker,
  MATTING_MODEL_URL,
  ORT_WASM_URL,
  POSE_MODEL_URL,
  loadModelBytes,
  prefetchWasm,
} from "./vision-runtime";
import { GRACE_MS, captureFlowReducer, isLiveScreen, initialCaptureFlow, targetAt, type CaptureEvent, type CaptureFlowState } from "./capture-flow";
import { GhostOverlay } from "./ghost-overlay";
import { HoldSound } from "./hold-sound";
import { DEFAULT_MATCHER_OPTIONS, PoseMatcher, type MatcherUpdate } from "./pose-matcher";
import { PoseTracker } from "./pose-tracker";
import { SoundRecorder, playClip } from "./sound-recorder";
import {
  canvasToPng,
  context2d,
  createCanvas,
  cutoutFromCrop,
  makeThumbnail,
  planFighterSprites,
  renderSprite,
  toPixelLandmarks,
  type MaskedCapture,
  type PoseCaptureGeometry,
  type SpritePlan,
} from "./sprite-normalizer";
import { strToU8, zipSync } from "fflate";
import { downloadBlob } from "./ui/dom";
import { loadStatusText, renderScreen, type ScreenActions } from "./ui/screens";
import { VoicePrompts, vibrate } from "./voice-prompts";

/** Everything captured so far in this session. */
export interface CaptureSessionData {
  fighterId: string;
  name: string;
  /** Main captures. */
  poses: Partial<Record<PoseId, CapturedPose>>;
  /** Second versions (uppercut, low kick, …), keyed by capture target ("punch-2"). */
  variants: Partial<Record<string, CapturedPose>>;
  /** Sprite object URLs, keyed by capture target (main poses use their pose id). */
  previews: Partial<Record<string, string>>;
  /** Recorded takes per sound (up to MAX_SOUND_TAKES). */
  sounds: Partial<Record<SoundId, Blob[]>>;
  sendProgress: number;
  lastFlipped: boolean;
}

const FRAMING_HINTS: Record<Exclude<FramingAdvice, "ok">, string> = {
  closer: "Come a bit closer",
  further: "Step a bit further back",
};
/** Still in the pose when the buffer between poses ends: they have to reset first, so the capture is deliberate. */
const BREAK_PROMPT = "Relax for a second, then strike the pose";
const FRAMING_VOICE = { settleMs: 1500, repeatMs: 5000 } as const;

/** `?debug=1`: keep raw frames and the matting stages so they can be exported for tuning. */
const DEBUG_MATTING = new URLSearchParams(location.search).has("debug");

interface StoredCapture {
  cut: MaskedCapture;
  /** PNG of the cut-out, encoded once for the draft. */
  png?: Blob;
  geometry: PoseCaptureGeometry;
  capturedAt: number;
  attackSide?: LimbSide;
}

interface LiveState {
  landmarks: ReturnType<PoseTracker["detectLive"]>;
  update: MatcherUpdate | null;
  framing: FramingAdvice | null;
}

interface DebugCapture {
  frame: HTMLCanvasElement | OffscreenCanvas;
  landmarks: NormalizedLandmark[];
  debug: MatteDebug;
  quality: CutoutQuality;
  /** Sharpness of each burst frame (the sharpest was used). */
  sharpness: number[];
}

const newSession = (): CaptureSessionData => ({
  fighterId: createFighterId(),
  name: "",
  poses: {},
  variants: {},
  previews: {},
  sounds: {},
  sendProgress: 0,
  lastFlipped: false,
});

class CaptureApp {
  private flow: CaptureFlowState;
  private data = newSession();
  private readonly camera = new CameraSession();
  private tracker: PoseTracker | null = null;
  private remover: BackgroundRemover | null = null;
  private recorder: SoundRecorder | null = null;
  private readonly voice = new VoicePrompts();
  private readonly holdSound = new HoldSound();
  private matcher: PoseMatcher | null = null;
  private stopFrames: (() => void) | null = null;
  private overlay: GhostOverlay | null = null;
  private live: LiveState = { landmarks: null, update: null, framing: null };
  private capturing = false;
  private readonly ghostFitter = new GhostFitter();
  /** "A bit closer" / "further" is spoken once it's been true for a moment, and not too often. */
  private framingVoice: { advice: FramingAdvice; since: number; spokenAt: number } = { advice: "ok", since: 0, spokenAt: -Infinity };
  /** Why the last capture came out rough, for the retake prompt. */
  private roughReason = "";
  /** Rough captures per target, so solo mode auto-retakes only once. */
  private readonly roughTries = new Map<string, number>();
  private canSwitchCamera = false;
  /** Model download progress, 0..1, for the loading screen. */
  private loadProgress = 0;
  private switchingCamera = false;
  private readonly debugCaptures = new Map<string, DebugCapture>();
  /** Cut-outs for every captured pose, so sprites can be re-rendered at the fighter-wide scale. */
  private readonly captures = new Map<string, StoredCapture>();
  private renderedScale = new Map<string, number>();
  /** Connection to the laptop, opened when the camera starts and reused for sending. */
  private readonly link: GameLink;
  private readonly linkChip = document.createElement("div");
  /** A saved in-progress capture offered on the intro screen. */
  private pendingDraft: CaptureDraft | null = null;
  private modelsPromise: Promise<void> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly root: HTMLElement) {
    this.flow = initialCaptureFlow(normalizeRoomCode(new URLSearchParams(location.search).get("room")));
    this.link = new GameLink(this.flow.roomCode, connectToGame);
    this.linkChip.className = "link-chip";
    this.linkChip.addEventListener("click", () => this.link.warmUp());
    document.body.append(this.linkChip);
    this.link.onStatus(() => this.updateLinkChip());
    this.render();
    void this.checkDraft();
  }

  // --- laptop link -----------------------------------------------------------------

  private updateLinkChip(): void {
    const st = this.link.status;
    const room = this.flow.roomCode;
    this.linkChip.hidden = !room || st.kind === "idle";
    this.linkChip.dataset.state = st.kind;
    this.linkChip.textContent =
      st.kind === "connecting" ? `Connecting to game ${room}…`
      : st.kind === "connected" ? `● Connected to game ${room}`
      : st.kind === "failed" ? `Can't reach game ${room} — tap to retry`
      : st.kind === "closed" ? "Disconnected from the game — tap to reconnect"
      : "";
  }

  // --- drafts ------------------------------------------------------------------------

  private async checkDraft(): Promise<void> {
    const draft = await loadDraft<CaptureDraft>().catch(() => undefined);
    if (!isResumable(draft)) return;
    this.pendingDraft = draft;
    if (this.flow.screen.name === "intro") this.render();
  }

  /** Save after each change (debounced); a reload or a locked phone then loses nothing. */
  private saveDraftSoon(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.saveDraftNow(), 400);
  }

  private async saveDraftNow(): Promise<void> {
    this.draftTimer = null;
    if (!this.captures.size) return;
    const captures: DraftCapture[] = [];
    for (const [key, c] of this.captures) {
      c.png ??= await canvasToPng(c.cut.image);
      captures.push({
        key, cutPng: c.png, offsetX: c.cut.offsetX, offsetY: c.cut.offsetY, geometry: c.geometry, capturedAt: c.capturedAt,
        ...(c.attackSide ? { attackSide: c.attackSide } : {}),
      });
    }
    const draft: CaptureDraft = {
      version: DRAFT_VERSION, savedAt: Date.now(), fighterId: this.data.fighterId, name: this.data.name,
      mode: this.flow.mode, roomCode: this.flow.roomCode, captures, sounds: this.data.sounds,
    };
    await saveDraft(draft).catch((err) => console.warn("[draft] couldn't save", err));
  }

  private async discardDraft(): Promise<void> {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    this.pendingDraft = null;
    await clearDraft().catch(() => {});
  }

  private async resumeDraft(): Promise<void> {
    const draft = this.pendingDraft;
    if (!draft) return;
    this.pendingDraft = null;
    this.voice.unlock();
    this.holdSound.unlock();
    this.data.fighterId = draft.fighterId;
    this.data.name = draft.name;
    this.data.sounds = draft.sounds ?? {};
    for (const c of draft.captures) {
      const bitmap = await createImageBitmap(c.cutPng);
      const image = createCanvas(bitmap.width, bitmap.height);
      context2d(image).drawImage(bitmap, 0, 0);
      bitmap.close();
      this.captures.set(c.key, {
        cut: { image, offsetX: c.offsetX, offsetY: c.offsetY }, png: c.cutPng, geometry: c.geometry, capturedAt: c.capturedAt,
        ...(c.attackSide ? { attackSide: c.attackSide } : {}),
      });
    }
    await this.renderSprites();
    const roomCode = this.flow.roomCode ?? draft.roomCode;
    this.link.setRoom(roomCode);
    this.dispatch({ type: "resume", mode: draft.mode, roomCode: draft.roomCode, nextPoseIndex: summarizeDraft(draft).nextPoseIndex });
    this.link.warmUp();
  }

  private dispatch(event: CaptureEvent): void {
    const before = this.flow;
    this.flow = captureFlowReducer(this.flow, event);
    if (this.flow !== before) this.onEnter(before);
  }

  /** Side effects when the screen changes. */
  private onEnter(previous: CaptureFlowState): void {
    const s = this.flow.screen;
    const wasLive = isLiveScreen(previous.screen);
    const isLive = isLiveScreen(s);
    if (wasLive && !isLive) this.stopLive();
    if (s.name === "loading") {
      this.ensureModels().then(() => this.dispatch({ type: "modelsReady" }), (err) => this.failModels(err));
    }
    if (s.name === "pose") this.startPose(s.poseIndex);
    if (s.name === "sounds" && !SoundRecorder.isSupported()) return this.dispatch({ type: "skipAllSounds" });
    if (s.name === "sending") void this.send();
    if (s.name === "saved" && previous.screen.name === "preview") void this.saveLocal();
    if (s.name === "error") this.stopLive();
    // The live capture screen keeps its DOM; only its HUD updates.
    if (!(isLive && wasLive)) this.render();
    else this.renderHud();
  }

  private render(): void {
    renderScreen(this.root, this.flow, this.data, this.actions, {
      video: this.camera.video,
      mirrored: this.camera.isFrontFacing,
      loadProgress: this.loadProgress,
      canSwitchCamera: this.canSwitchCamera,
      onOverlay: (canvas) => { this.overlay = new GhostOverlay(canvas); },
      voiceEnabled: this.voice.enabled,
      voiceSupported: this.voice.supported,
      recordingSupported: SoundRecorder.isSupported(),
      draft: this.pendingDraft ? summarizeDraft(this.pendingDraft) : null,
      debug: DEBUG_MATTING,
    });
    if (isLiveScreen(this.flow.screen)) this.renderHud();
  }

  private renderHud(): void {
    const s = this.flow.screen;
    if (!isLiveScreen(s)) return;
    const target = targetAt(s.poseIndex);
    const def = target.definition;
    const step = this.root.querySelector<HTMLElement>("[data-hud=step]");
    const label = this.root.querySelector<HTMLElement>("[data-hud=label]");
    const hint = this.root.querySelector<HTMLElement>("[data-hud=hint]");
    const manual = this.root.querySelector<HTMLButtonElement>("[data-hud=manual]");
    if (step) step.textContent = `${s.poseIndex + 1} / ${CAPTURE_TARGETS.length}${s.retake ? " · retake" : ""}`;
    if (label) label.textContent = def.label;
    const rough = s.name === "captured" && s.rough;
    if (hint) {
      hint.textContent = rough ? `That one came out rough — retake? (${this.roughReason})` : s.name === "captured" ? "Got it!" : this.hintText();
    }
    if (manual) manual.hidden = !(s.name === "pose" && this.live.update?.manualCaptureAvailable);
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-hud=rough-retake], [data-hud=rough-keep]")) el.hidden = !rough;
    const cutout = this.root.querySelector<HTMLImageElement>("[data-hud=cutout]");
    const url = this.data.previews[target.key];
    if (cutout) {
      cutout.hidden = s.name !== "captured" || !url;
      if (url && cutout.src !== url) cutout.src = url;
    }
  }

  private hintText(): string {
    const s = this.flow.screen;
    if (s.name !== "pose") return "";
    const def = targetAt(s.poseIndex).definition;
    const { landmarks, update, framing } = this.live;
    if (!landmarks) return "Step into the frame";
    const inFrame = update !== null && update.score !== Infinity;
    if (!inFrame) {
      return framing === "closer" ? "A bit closer — whole body in frame" : framing === "further" ? "A bit further back — head to feet in frame" : "Whole body in frame, please";
    }
    if (update.matching) return "Hold it…";
    if (update.awaitingBreak) return BREAK_PROMPT;
    if (framing && framing !== "ok") return FRAMING_HINTS[framing];
    return def.voicePrompt;
  }

  // --- actions from the UI ------------------------------------------------------

  private readonly actions: ScreenActions = {
    selectMode: (mode) => this.dispatch({ type: "selectMode", mode }),
    setRoomCode: (code) => {
      this.flow = { ...this.flow, roomCode: normalizeRoomCode(code) };
      this.link.setRoom(this.flow.roomCode);
      if (this.flow.screen.name !== "intro") this.link.warmUp();
      this.updateLinkChip();
      this.render();
    },
    resumeDraft: () => void this.resumeDraft(),
    discardDraft: () => void this.discardDraft().then(() => this.render()),
    setVoice: (enabled) => { this.voice.enabled = enabled; },
    start: () => {
      this.voice.unlock();
      this.holdSound.unlock();
      this.link.warmUp(); // find out now, not after thirteen poses, whether the laptop is reachable
      this.dispatch({ type: "start" });
    },
    manualCapture: () => {
      this.matcher?.forceCapture();
      void this.capture();
    },
    switchCamera: () => void this.switchCamera(),
    retakeRough: () => this.dispatch({ type: "retakeRough" }),
    keepRough: () => this.dispatch({ type: "keepRough" }),
    retake: (targetKey) => this.dispatch({ type: "retake", targetKey }),
    reviewDone: () => this.dispatch({ type: "reviewDone" }),
    recordSound: async (soundId, onLevel) => {
      const takes = (this.data.sounds[soundId] ??= []);
      if (takes.length >= MAX_SOUND_TAKES) return;
      try {
        this.recorder ??= await SoundRecorder.open();
        const clip = await this.recorder.record(undefined, onLevel);
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
    retrySend: () => this.dispatch({ type: "retrySend" }),
    download: () => void this.download(),
    downloadDebug: () => void this.downloadDebug(),
    restart: () => {
      Object.values(this.data.previews).forEach((u) => u && URL.revokeObjectURL(u));
      this.data = newSession();
      this.captures.clear();
      this.renderedScale.clear();
      this.debugCaptures.clear();
      this.roughTries.clear();
      void this.discardDraft();
      this.dispatch({ type: "restart" });
    },
  };

  // --- camera + models -------------------------------------------------------------

  /**
   * Camera + pose and matting models, loaded once (also when a resumed
   * draft goes straight to a retake). Downloads come first, with progress; the
   * models are then built from the model cache.
   */
  private ensureModels(): Promise<void> {
    this.modelsPromise ??= (async () => {
      const camera = this.camera.isRunning ? Promise.resolve() : this.camera.start("environment");
      if (!this.tracker || !this.remover) {
        // Estimated sizes until the real ones arrive, so the bar moves evenly.
        const downloads = new DownloadTracker({ wasm: 13.5e6, pose: 30.7e6, ort: 28.3e6, matting: 178.6e6 }, (f) => this.setLoadProgress(f));
        await Promise.all([
          prefetchWasm(downloads.reporter("wasm")),
          loadModelBytes(POSE_MODEL_URL, downloads.reporter("pose")),
          loadModelBytes(ORT_WASM_URL, downloads.reporter("ort")),
          loadModelBytes(MATTING_MODEL_URL, downloads.reporter("matting")),
        ]);
      }
      this.setLoadProgress(1);
      const [, tracker, remover] = await Promise.all([
        camera,
        this.tracker ? Promise.resolve(this.tracker) : PoseTracker.create(),
        this.remover ? Promise.resolve(this.remover) : BackgroundRemover.create(),
      ]);
      this.tracker = tracker;
      this.remover = remover;
      this.canSwitchCamera = await this.camera.canSwitch();
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
    const e = err as DOMException;
    const message = e.name === "NotAllowedError"
      ? "Camera permission was denied. Allow camera access in your browser settings and start over."
      : `Couldn't start the camera or pose models: ${e.message}`;
    this.dispatch({ type: "fail", message });
  }


  private startPose(index: number): void {
    const def = targetAt(index).definition;
    this.matcher = new PoseMatcher(def);
    this.matcher.start(performance.now());
    this.live = { landmarks: null, update: null, framing: null };
    this.voice.say(def.voicePrompt);
    if (!this.tracker) this.ensureModels().then(() => this.render(), (err) => this.failModels(err));
    if (!this.stopFrames) this.stopFrames = this.camera.onFrame((now) => this.onFrame(now));
  }

  private stopLive(): void {
    this.holdSound.cancel();
    this.stopFrames?.();
    this.stopFrames = null;
  }

  private onFrame(now: number): void {
    const s = this.flow.screen;
    if (!this.tracker || !this.overlay || this.switchingCamera || !this.camera.width || !isLiveScreen(s)) return;
    const W = this.camera.width;
    const H = this.camera.height;
    this.overlay.resize(W, H);
    const target = targetAt(s.poseIndex);
    const def = target.definition;
    if (s.name === "pose" && this.matcher && !this.capturing && this.tracker.shouldDetect(now)) {
      const landmarks = this.tracker.detectLive(this.camera.video, now);
      // Score in pixel space so angles aren't distorted by the frame's aspect ratio.
      const px = landmarks ? toPixelLandmarks(landmarks, W, H) : null;
      const update = this.matcher.update(px, now);
      const framing = px ? framingAdvice(px, W, H) : null;
      // The jump lifts the feet; keep the ghost on the floor.
      this.ghostFitter.update(px, W, H, now, { holdVertical: target.poseId === "jump" });
      this.live = { landmarks, update, framing };
      if (update.events.includes("holdStarted")) {
        this.holdSound.start(DEFAULT_MATCHER_OPTIONS.holdMs);
        this.voice.say("Hold it");
      }
      if (update.events.includes("holdBroken")) this.holdSound.cancel();
      if (update.events.includes("tolerancesWidened")) this.voice.say("Close enough works too");
      if (update.events.includes("breakNeeded")) this.voice.say(BREAK_PROMPT);
      if (update.events.includes("captured")) void this.capture();
      if (!update.matching) this.speakFraming(framing, now);
      this.renderHud();
    }
    this.overlay.draw({
      ghostPath: def.ghostSvgPath,
      ghostFit: this.ghostFitter.peek(W, H),
      landmarks: s.name === "pose" ? this.live.landmarks : null,
      holdProgress: s.name === "captured" ? 1 : this.live.update?.holdProgress ?? 0,
      matching: s.name === "captured" || (this.live.update?.matching ?? false),
      large: this.flow.mode === "solo",
      message: "",
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
    if (this.switchingCamera || this.capturing) return;
    this.switchingCamera = true;
    try {
      await this.camera.switchCamera();
    } catch (err) {
      console.warn("[camera] switch failed", err);
      this.toast("Couldn't switch camera");
    } finally {
      this.switchingCamera = false;
    }
    this.ghostFitter.reset();
    const s = this.flow.screen;
    if (!isLiveScreen(s)) return;
    // Re-render for the mirrored class and a fresh overlay; restart the frame loop on the new stream.
    this.render();
    this.stopFrames?.();
    this.stopFrames = this.camera.onFrame((now) => this.onFrame(now));
  }

  /** Grab the sharpest of a short burst, re-detect on the still, segment, normalize, store. */
  private async capture(): Promise<void> {
    const s = this.flow.screen;
    if (s.name !== "pose" || this.capturing || !this.tracker || !this.remover) return;
    this.capturing = true;
    const target = targetAt(s.poseIndex);
    const side = this.matcher?.side ?? "right";
    const liveLandmarks = this.live.landmarks;
    this.holdSound.complete();
    this.voice.say("Got it");
    vibrate(80);
    this.dispatch({ type: "poseCaptured" });
    const graceDone = new Promise((r) => setTimeout(r, GRACE_MS[this.flow.mode]));
    try {
      // Judge sharpness on the person, not the (often blurry or flat) background.
      const region = liveLandmarks ? personCropRect(toPixelLandmarks(liveLandmarks, this.camera.width, this.camera.height), this.camera.width, this.camera.height) : null;
      const { frame, sharpness } = await this.camera.grabSharpest(BURST_FRAMES, region);
      const W = frame.width;
      const H = frame.height;
      const still = (await this.tracker.detectStill(frame)) ?? liveLandmarks;
      if (!still) throw new Error("No one in the picture");
      const { foreground, debug } = await this.remover.cutout(frame, still);
      console.info(`[capture] matting took ${debug.inferenceMs} ms on ${debug.backend}`);
      const quality = assessCutout({ alpha: debug.alpha, rect: debug.rect, frameWidth: W, frameHeight: H, landmarks: toPixelLandmarks(still, W, H) });
      if (DEBUG_MATTING) this.debugCaptures.set(target.key, { frame, landmarks: still, debug, quality, sharpness });
      this.captures.set(target.key, {
        cut: cutoutFromCrop(foreground, debug.rect),
        geometry: { poseId: target.poseId, landmarks: still, frameWidth: W, frameHeight: H },
        capturedAt: Date.now(),
        ...(target.definition.attackLimb ? { attackSide: side } : {}),
      });
      const plans = await this.renderSprites();
      this.saveDraftSoon();
      this.data.lastFlipped = plans[target.key]?.flipped ?? false;
      this.renderHud();
      if (this.data.lastFlipped) this.toast("Flipped so you face right");
      const autoRetake = this.checkQuality(target.key, quality);
      await graceDone;
      this.capturing = false;
      this.dispatch({ type: autoRetake ? "retakeRough" : "graceElapsed" });
    } catch (err) {
      console.warn("[capture] failed", err);
      this.capturing = false;
      this.toast(`Didn't work (${(err as Error).message}). Try again.`);
      this.voice.say("Let's try that again");
      await graceDone;
      this.dispatch({ type: "captureFailed" });
    }
  }

  /**
   * Flag a rough cut-out right away. Friend mode asks "retake?"; solo mode
   * (nobody near the screen) retakes once on its own, then keeps what it gets.
   * Returns true when the pose should be retaken automatically.
   */
  private checkQuality(key: string, quality: CutoutQuality): boolean {
    if (!quality.issues.length) {
      this.roughTries.delete(key);
      return false;
    }
    console.info("[capture] rough cut-out", key, quality);
    const tries = (this.roughTries.get(key) ?? 0) + 1;
    this.roughTries.set(key, tries);
    this.roughReason = describeCutoutIssues(quality.issues);
    if (this.flow.mode === "solo" && tries > 1) {
      this.toast("Still a bit rough — kept it. You can retake it from the review.");
      return false;
    }
    this.dispatch({ type: "captureRough" });
    this.voice.say(this.flow.mode === "solo" ? "That one came out rough. Let's go again." : "That one came out rough. Retake?");
    return this.flow.mode === "solo";
  }

  /**
   * Plan all captured poses together (one scale for the fighter) and re-render
   * any sprite whose scale changed, e.g. when a new pose needs everything to
   * shrink a little to fit the canvas.
   */
  private async renderSprites(): Promise<Record<string, SpritePlan>> {
    const plans = planFighterSprites(Object.fromEntries([...this.captures].map(([key, c]) => [key, c.geometry])));
    for (const [key, c] of this.captures) {
      const plan = plans[key];
      const previous = this.renderedScale.get(key);
      if (previous !== undefined && Math.abs(previous - plan.transform.scale) <= 1e-6 * previous) continue;
      const imageBlob = await renderSprite(c.cut, plan);
      this.renderedScale.set(key, plan.transform.scale);
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
    const viewport = this.root.querySelector(".viewport");
    if (!viewport) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    viewport.append(el);
    setTimeout(() => el.remove(), 1800);
  }

  // --- finish ------------------------------------------------------------------------

  private async buildFighter(): Promise<Fighter> {
    const missing = CAPTURE_TARGETS.filter((t) => !(t.variant ? this.data.variants[t.key] : this.data.poses[t.poseId])).map((t) => t.definition.label);
    if (missing.length) throw new Error(`Missing poses: ${missing.join(", ")}`);
    const poses = this.data.poses as Record<PoseId, CapturedPose>;
    const poseVariants: Partial<Record<PoseId, CapturedPose[]>> = {};
    for (const t of CAPTURE_TARGETS) {
      if (t.variant > 0) ((poseVariants[t.poseId] ??= [])[t.variant - 1] = this.data.variants[t.key]!);
    }
    const soundVariants: Partial<Record<SoundId, Blob[]>> = {};
    for (const id of SOUND_IDS) {
      const extra = (this.data.sounds[id] ?? []).slice(1);
      if (extra.length) soundVariants[id] = extra;
    }
    return {
      fighterId: this.data.fighterId,
      name: this.data.name.trim() || "New Fighter",
      schemaVersion: 1,
      createdAt: Date.now(),
      facingDirection: "right",
      poses,
      sounds: Object.fromEntries(SOUND_IDS.map((id) => [id, this.data.sounds[id]?.[0] ?? null])) as Record<SoundId, Blob | null>,
      thumbnailBlob: await makeThumbnail(poses.idle.imageBlob),
      poseVariants,
      ...(Object.keys(soundVariants).length ? { soundVariants } : {}),
    };
  }

  private async saveLocal(): Promise<Fighter | null> {
    try {
      const fighter = await this.buildFighter();
      await saveFighter(fighter);
      await this.discardDraft(); // it's a real fighter now
      return fighter;
    } catch (err) {
      this.dispatch({ type: "fail", message: `Couldn't save: ${(err as Error).message}` });
      return null;
    }
  }

  private async send(): Promise<void> {
    const fighter = await this.saveLocal();
    if (!fighter || !this.flow.roomCode) return;
    this.data.sendProgress = 0;
    try {
      const link = await this.link.ensure();
      await sendFighter(link.channel, fighter, {
        onProgress: ({ sentBytes, totalBytes }) => {
          this.data.sendProgress = sentBytes / totalBytes;
          const bar = this.root.querySelector<HTMLElement>("[data-progress]");
          if (bar) bar.style.width = `${Math.round(this.data.sendProgress * 100)}%`;
        },
      });
      // The link stays open for the next fighter.
      this.dispatch({ type: "sent" });
    } catch (err) {
      this.dispatch({ type: "sendFailed", reason: (err as Error).message });
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

  private async download(): Promise<void> {
    const fighter = await this.buildFighter();
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

/** Signaling + WebRTC to the laptop for a room code. */
async function connectToGame(roomCode: string): Promise<PeerLink> {
  const [{ client, welcome }, iceServers] = await Promise.all([SignalingClient.connect(roomCode, "guest"), fetchIceServers()]);
  try {
    return await connectAsGuest(client, welcome.peerPresent, iceServers);
  } catch (err) {
    client.close();
    throw err;
  }
}

const root = document.getElementById("app");
// Exposed for debugging from the console (and the e2e smoke test).
if (root) (window as unknown as { photoDojoCapture: CaptureApp }).photoDojoCapture = new CaptureApp(root);
