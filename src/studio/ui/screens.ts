import { ARCHETYPES, ARCHETYPE_IDS, type ArchetypeId } from "../../shared/archetypes";
import { MAX_SOUND_SECONDS, MAX_SOUND_TAKES, MAX_TYPED_NAME_LENGTH, SOUND_IDS, type PoseId, type SoundId } from "../../shared/fighter-model";
import { CAPTURE_TARGET_COUNT, SIGNATURE_DEFINITIONS, captureTargetsFor } from "../../shared/pose-definitions";
import { QUIET_PEAK, meterPosition, playClip, type AudioLevel } from "../../capture/sound-recorder";
import { describeAge, type CaptureMode, type DraftSummary } from "../capture-draft";
import type { CameraStatus } from "../camera-source";
import type { CameraDevice } from "../local-camera";
import type { PhoneHostStatus } from "../phone-host";
import { canRetake, targetAt, type StudioFlowState } from "../studio-flow";
import { clear, h } from "./dom";

/** Everything captured so far in this session (as the screens see it). */
export interface StudioSessionData {
  name: string;
  /** Sprite object URLs, keyed by capture target (main poses use their pose id). */
  previews: Partial<Record<string, string>>;
  /** Recorded takes per sound (up to MAX_SOUND_TAKES). */
  sounds: Partial<Record<SoundId, Blob[]>>;
}

export interface ScreenActions {
  selectMode(mode: CaptureMode): void;
  resumeDraft(): void;
  discardDraft(): void;
  setVoice(enabled: boolean): void;
  usePhone(): void;
  useLocal(deviceId: string | null): void;
  retryCamera(): void;
  setupDone(): void;
  start(): void;
  cancelCamera(): void;
  manualCapture(): void;
  switchCamera(): void;
  retakeRough(): void;
  keepRough(): void;
  retake(targetKey: string): void;
  pickArchetype(archetype: ArchetypeId): void;
  changeArchetype(): void;
  reviewDone(): void;
  recordSound(soundId: SoundId, onLevel?: (level: AudioLevel) => void): Promise<void>;
  removeTake(soundId: SoundId, index: number): void;
  stopRecording(): void;
  playSound(soundId: SoundId, index: number): void;
  soundDone(): void;
  skipSound(soundId: SoundId): void;
  skipAllSounds(): void;
  setName(name: string): void;
  finish(): void;
  download(): void;
  downloadDebug(): void;
  restart(): void;
  /** Editing a fighter without sources: take every pose again. */
  recaptureAll(): void;
}

/** The camera half of setup (also the camera and camera-lost screens). */
export interface CameraPanelEnv {
  choice: "phone" | "local" | null;
  /** The source's status (null: none picked yet). */
  status: CameraStatus | null;
  video: HTMLVideoElement | null;
  mirrored: boolean;
  phone: { host: PhoneHostStatus; qrDataUrl: string | null; url: string } | null;
  cameras: CameraDevice[];
  deviceId: string | null;
}

export interface ScreenEnv {
  camera: CameraPanelEnv;
  /** Model download progress (0..1) for the loading screen. */
  loadProgress: number;
  canSwitchCamera: boolean;
  onOverlay(canvas: HTMLCanvasElement): void;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  /** `?debug=1`: offer the matting debug export. */
  debug: boolean;
  /** A saved, unfinished capture that can be resumed. */
  draft: DraftSummary | null;
  /** The draft is being loaded: the setup screen's buttons wait. */
  resuming: boolean;
  /** A message for the current screen (e.g. why saving failed). */
  notice: string;
  /** Where "Back to the game" goes. */
  gameUrl: string;
  /** iPads may run the studio, but a computer works better. */
  tabletWarning: boolean;
  /** Editing a saved fighter (`?edit=`), not building a new one. */
  editing: boolean;
  /** `?edit=`: the fighter is still being read. */
  openingEdit: boolean;
}

const SOUND_PROMPTS: Record<SoundId, { title: string; hint: string }> = {
  attack: { title: "Battle cry", hint: "Plays when you punch or kick. “Hyah!”" },
  hurt: { title: "Ouch", hint: "Plays when you get hit." },
  win: { title: "Victory line", hint: "Plays when you win a round." },
};

const panel = (cls: string, ...children: (Node | string | null | false)[]) => h("section", { class: `panel ${cls}` }, ...children);

/** All sixteen poses. Clicking one retakes it; `current` marks the pose being taken. */
function strip(data: StudioSessionData, archetype: ArchetypeId | null, onPick?: (targetKey: string) => void, current?: string): HTMLElement {
  return h("div", { class: "strip" },
    ...captureTargetsFor(archetype ?? "brawler").map((t) =>
      h("button", { type: "button", class: t.key === current ? "current" : "", disabled: !onPick, dataset: { key: t.key }, on: { click: () => onPick?.(t.key) } },
        data.previews[t.key] ? h("img", { src: data.previews[t.key], alt: t.key }) : h("div", { class: "muted empty" }, "—"),
        h("span", {}, t.definition.label),
      ),
    ),
  );
}

const randomTake = (data: StudioSessionData, id: SoundId) => {
  const takes = data.sounds[id] ?? [];
  return takes[Math.floor(Math.random() * takes.length)];
};

/** A pose's stick-figure ghost (path data in 512×512 sprite space) as an inline SVG. */
function ghost(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", path);
  svg.append(p);
  return svg;
}

/** Scripted showcase with hard cuts: idle → walk → punch → kick → signature → win, with the recorded sounds. */
function showcase(data: StudioSessionData, archetype: ArchetypeId): HTMLCanvasElement {
  const canvas = h("canvas", { class: "showcase", width: 512, height: 512 });
  const ctx = canvas.getContext("2d")!;
  // Both versions of each pose, so the showcase mixes in the alternates.
  const images = new Map<PoseId, HTMLImageElement[]>();
  for (const t of captureTargetsFor(archetype)) {
    const url = data.previews[t.key];
    if (url) images.set(t.poseId, [...(images.get(t.poseId) ?? []), h("img", { src: url })]);
  }
  const script: { pose: PoseId; ms: number; sound?: SoundId }[] = [
    { pose: "idle", ms: 700 }, { pose: "walk", ms: 280 }, { pose: "idle", ms: 280 }, { pose: "walk", ms: 280 },
    { pose: "idle", ms: 250 }, { pose: "punch", ms: 380, sound: "attack" }, { pose: "idle", ms: 300 },
    { pose: "kick", ms: 450, sound: "attack" }, { pose: "idle", ms: 300 }, { pose: "hurt", ms: 400, sound: "hurt" },
    { pose: "jump", ms: 400 }, { pose: "idle", ms: 250 }, { pose: "signature", ms: 600, sound: "attack" },
    { pose: "win", ms: 1400, sound: "win" },
  ];
  let step = -1;
  let next = 0;
  const tick = (now: number) => {
    if (!canvas.isConnected && step >= 0) return;
    if (now >= next) {
      step = (step + 1) % script.length;
      const s = script[step];
      next = now + s.ms;
      ctx.clearRect(0, 0, 512, 512);
      const versions = images.get(s.pose) ?? [];
      const img = versions[Math.floor(Math.random() * versions.length)];
      if (img?.complete) ctx.drawImage(img, 0, s.pose === "jump" ? -90 : 0, 512, 512);
      if (s.sound && step > 0) void playClip(randomTake(data, s.sound));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return canvas;
}

export function loadStatusText(progress: number): string {
  return progress < 1 ? `Downloading models… ${Math.round(progress * 100)}%` : "Starting the pose and background-removal models…";
}

/** One line about the camera's state. */
export function cameraStatusText(env: CameraPanelEnv): string {
  const st = env.status;
  if (env.choice === "phone") {
    const host = env.phone?.host;
    if (st?.kind === "ready") return "● Phone connected";
    if (host?.kind === "connected") return "Phone connected, starting its video…";
    if (host?.kind === "opening") return host.reason ? `Can't open the room (${host.reason}), retrying…` : "Opening a room…";
    if (st?.kind === "lost") return `Phone disconnected (${st.reason}). Waiting for it to come back…`;
    return "Waiting for the phone…";
  }
  if (env.choice === "local") {
    if (!st || st.kind === "starting") return "Starting the camera…";
    if (st.kind === "ready") return "● Camera on";
    if (st.kind === "lost") return `Camera stopped: ${st.reason}`;
    return "Camera off";
  }
  return "Pick a camera";
}

/** Camera choice: a phone (QR + code), or a camera on this computer (list + retry); a live preview once it's up. */
function cameraPanel(env: CameraPanelEnv, a: ScreenActions): HTMLElement {
  const ready = env.status?.kind === "ready";
  const phoneDetails = env.choice === "phone" && env.phone
    ? h("div", { class: `phone-join${ready ? " connected" : ""}` },
        env.phone.qrDataUrl ? h("img", { class: "qr", src: env.phone.qrDataUrl, alt: "QR code for the phone camera page" }) : h("div", { class: "qr" }),
        h("div", {},
          h("p", {}, "Scan with the phone, or open ", h("strong", {}, env.phone.url.replace(/^https?:\/\//, "").replace(/\?.*$/, "")), " and enter:"),
          h("p", { class: "code", dataset: { roomCode: "" } }, env.phone.host.roomCode),
          h("p", { class: "muted" }, "Prop the phone up 3–4 m away, rear camera towards you. One phone at a time."),
        ),
      )
    : null;
  const localDetails = env.choice === "local"
    ? h("div", { class: "row" },
        env.cameras.length > 1
          ? h("select", { "aria-label": "Camera", on: { change: (ev) => a.useLocal((ev.target as HTMLSelectElement).value) } },
              ...env.cameras.map((c) => h("option", { value: c.deviceId, selected: c.deviceId === env.deviceId }, c.label)))
          : null,
        env.status?.kind === "lost" ? h("button", { type: "button", class: "primary", on: { click: () => a.retryCamera() } }, "Retry") : null,
      )
    : null;
  return h("div", { class: "camera-panel" },
    h("div", { class: "row choices" },
      h("button", { type: "button", class: env.choice === "phone" ? "primary" : "", dataset: { camera: "phone" }, on: { click: () => a.usePhone() } },
        "Use a phone", h("small", {}, "Its camera streams here over Wi-Fi.")),
      h("button", { type: "button", class: env.choice === "local" ? "primary" : "", dataset: { camera: "local" }, on: { click: () => a.useLocal(null) } },
        "This computer's camera", h("small", {}, "Webcam, USB camera or Continuity Camera.")),
    ),
    phoneDetails,
    localDetails,
    h("p", { class: `camera-status${ready ? " ok" : env.status?.kind === "lost" ? " bad" : ""}`, dataset: { cameraStatus: "" } }, cameraStatusText(env)),
    ready && env.video ? h("div", { class: `preview${env.mirrored ? " mirrored" : ""}` }, env.video) : null,
  );
}

export function renderScreen(root: HTMLElement, flow: StudioFlowState, data: StudioSessionData, a: ScreenActions, env: ScreenEnv): void {
  const s = flow.screen;
  clear(root);
  const notice = env.notice ? h("p", { class: "error" }, env.notice) : null;
  const playVideo = () => { if (env.camera.video) void env.camera.video.play().catch(() => {}); };

  switch (s.name) {
    case "setup": {
      if (env.openingEdit) {
        root.append(panel("narrow", h("h2", {}, "Opening your fighter…"), h("p", { class: "muted" }, "Reading it from this browser.")));
        break;
      }
      const ready = env.camera.status?.kind === "ready";
      root.append(h("div", { class: "setup" },
        panel("camera",
          h("h2", {}, "1. Camera"),
          cameraPanel(env.camera, a),
        ),
        panel("options",
          h("h2", {}, "2. Get ready"),
          env.tabletWarning ? h("p", { class: "muted" }, "Tip: the studio works best on a computer; a tablet may run out of memory.") : null,
          env.draft
            ? h("div", { class: "resume" },
                h("strong", {}, "Pick up where you left off?"),
                h("p", { class: "muted" }, `${env.draft.captured} of ${CAPTURE_TARGET_COUNT} poses captured · ${describeAge(env.draft.ageMs)}`),
                h("div", { class: "row" },
                  h("button", { type: "button", class: "primary", disabled: env.resuming, on: { click: () => a.resumeDraft() } }, env.resuming ? "Loading your draft…" : "Resume"),
                  h("button", { type: "button", disabled: env.resuming, on: { click: () => a.discardDraft() } }, "Start fresh"),
                ),
              )
            : null,
          h("p", {}, `Strike ${CAPTURE_TARGET_COUNT} poses, record ${SOUND_IDS.length} battle cries, and become a fighter.`),
          h("div", { class: "choices" },
            h("button", { type: "button", class: flow.mode === "solo" ? "primary" : "", dataset: { mode: "solo" }, on: { click: () => a.selectMode("solo") } },
              "On my own", h("small", {}, "Big prompts, and a pause after each pose to get back in position.")),
            h("button", { type: "button", class: flow.mode === "helped" ? "primary" : "", dataset: { mode: "helped" }, on: { click: () => a.selectMode("helped") } },
              "Someone's helping", h("small", {}, "A friend watches the screen; shorter pauses.")),
          ),
          env.voiceSupported
            ? h("label", { class: "check" },
                h("input", { type: "checkbox", checked: env.voiceEnabled, on: { change: (ev) => a.setVoice((ev.target as HTMLInputElement).checked) } }),
                "Spoken prompts")
            : null,
          h("button", { type: "button", class: "primary big", disabled: !ready || env.resuming, dataset: { action: "start" }, on: { click: () => a.setupDone() } },
            ready ? "Start" : "Start (pick a camera first)"),
          h("p", { class: "privacy" },
            h("strong", {}, "Private by design. "),
            "Photos and voice are processed on this computer and saved in this browser, nowhere else. A phone's picture comes straight here, peer to peer. There's no cloud backup, so export fighters you love from fighter select."),
          h("p", { class: "muted" }, h("a", { href: `${import.meta.env.BASE_URL}about`, target: "_blank", rel: "noopener" }, "About, FAQ & credits")),
        ),
      ));
      playVideo();
      break;
    }
    case "camera": {
      const label = targetAt(s.next.poseIndex, flow.archetype).definition.label;
      root.append(panel("narrow",
        h("h2", {}, `A camera for “${label}”`),
        h("p", { class: "muted" }, "The camera isn't on. Pick one to take the pose."),
        cameraPanel(env.camera, a),
        s.next.retake ? h("button", { type: "button", on: { click: () => a.cancelCamera() } }, "Back to the review") : null,
      ));
      playVideo();
      break;
    }
    case "cameraLost":
      root.append(panel("narrow",
        h("h2", {}, env.camera.choice === "phone" ? "Phone disconnected" : "The camera stopped"),
        h("p", { class: "muted" }, env.camera.choice === "phone"
          ? "Keep the camera page open on the phone: it reconnects by itself. Or scan the code again."
          : "Retry, or pick another camera. Capturing carries on from the same pose."),
        cameraPanel(env.camera, a),
      ));
      playVideo();
      break;
    case "tips":
      root.append(panel("narrow",
        h("h2", {}, "Before you start"),
        h("ul", { class: "tips" },
          h("li", {}, "Stand in front of a plain wall."),
          h("li", {}, "Get your whole body in the frame, head to feet (about 3–4 m back)."),
          h("li", {}, "Stand sideways, facing to your right."),
          h("li", {}, "Match the white ghost. Hold still when it turns green."),
        ),
        h("button", { type: "button", class: "primary big", on: { click: () => a.start() } }, "Let's go"),
      ));
      break;
    case "loading":
      root.append(panel("narrow",
        h("h2", {}, "Warming up…"),
        h("p", { class: "muted", dataset: { loadStatus: "" } }, loadStatusText(env.loadProgress)),
        h("div", { class: "progress" }, h("div", { dataset: { loadProgress: "" }, style: `width: ${Math.round(env.loadProgress * 100)}%` })),
        h("p", { class: "muted" }, "The first time, this downloads about 250 MB of pose and background-removal models. After that they're stored on this computer and load in seconds."),
      ));
      break;
    case "pose":
    case "captured": {
      const overlay = h("canvas", { class: "overlay" });
      env.onOverlay(overlay);
      const current = targetAt(s.poseIndex, flow.archetype).key;
      root.append(h("div", { class: `live${env.camera.mirrored ? " mirrored" : ""}${flow.mode === "solo" ? " large" : ""}` },
        h("div", { class: "viewport" },
          env.camera.video,
          overlay,
          h("div", { class: "hud" },
            h("div", { class: "step", dataset: { hud: "step" } }),
            h("div", { class: "label", dataset: { hud: "label" } }),
            h("div", { class: "hint", dataset: { hud: "hint" } }),
          ),
          h("img", { class: "cutout", dataset: { hud: "cutout" }, hidden: true, alt: "" }),
        ),
        h("aside", { class: "side" },
          h("div", { class: "controls" },
            h("button", { type: "button", class: "primary", dataset: { hud: "manual" }, hidden: true, on: { click: () => a.manualCapture() } }, "Capture anyway"),
            h("button", { type: "button", class: "primary", dataset: { hud: "rough-retake" }, hidden: true, on: { click: () => a.retakeRough() } }, "Retake"),
            h("button", { type: "button", dataset: { hud: "rough-keep" }, hidden: true, on: { click: () => a.keepRough() } }, "Keep it"),
            env.canSwitchCamera
              ? h("button", { type: "button", class: "switch", title: "Switch camera", "aria-label": "Switch camera", dataset: { hud: "switch" }, on: { click: () => a.switchCamera() } }, "⇄ Camera")
              : null,
          ),
          strip(data, flow.archetype, undefined, current),
          h("p", { class: "muted", dataset: { cameraStatus: "" } }, cameraStatusText(env.camera)),
        ),
      ));
      playVideo();
      break;
    }
    case "archetype":
      root.append(panel("wide",
        h("h2", {}, "Pick your fighting style"),
        h("p", { class: "muted" }, s.retake
          ? "A new style means a new signature pose. Pick your current one to keep it."
          : "It gives you one signature move (down + punch + kick), and it's your next pose."),
        h("div", { class: "choices archetypes" },
          ...ARCHETYPE_IDS.map((id) =>
            h("button", { type: "button", class: id === flow.archetype ? "primary" : "", dataset: { archetype: id }, on: { click: () => a.pickArchetype(id) } },
              ghost(SIGNATURE_DEFINITIONS[id].ghostSvgPath),
              h("span", {}, `${ARCHETYPES[id].name}: ${ARCHETYPES[id].moveName}`, h("small", {}, ARCHETYPES[id].blurb)),
            ),
          ),
        ),
      ));
      break;
    case "review": {
      const retakes = canRetake(flow);
      root.append(panel("wide",
        h("h2", {}, env.editing ? `Editing ${data.name.trim() || "your fighter"}` : "Your moves"),
        h("p", { class: "muted" }, retakes
          ? "Click a pose to retake it."
          : "This fighter came from a file or the old phone capture, so single poses can't be retaken here. Rename it, redo its sounds, or capture every pose again."),
        strip(data, flow.archetype, retakes ? a.retake : undefined),
        h("div", { class: "row" },
          retakes
            ? h("button", { type: "button", on: { click: () => a.changeArchetype() } }, `Style: ${ARCHETYPES[flow.archetype!].name} · change`)
            : h("button", { type: "button", dataset: { action: "recapture-all" }, on: { click: () => a.recaptureAll() } }, "Capture all poses again"),
          h("button", { type: "button", class: "primary", on: { click: () => a.reviewDone() } }, env.editing ? "Next: sounds" : "Looks good"),
        ),
        env.debug ? h("button", { type: "button", on: { click: () => a.downloadDebug() } }, "Download matting debug (zip)") : null,
      ));
      break;
    }
    case "sounds": {
      const soundId = SOUND_IDS[s.soundIndex];
      const prompt = SOUND_PROMPTS[soundId];
      const takes = data.sounds[soundId] ?? [];
      const full = takes.length >= MAX_SOUND_TAKES;
      const status = h("p", { class: "muted" },
        takes.length ? `${takes.length} take${takes.length > 1 ? "s" : ""}. The game picks one at random each time.` : `Click record and shout at the computer. Stops after ${MAX_SOUND_SECONDS[soundId]} seconds.`);
      const record = h("button", { type: "button", class: takes.length ? "" : "primary", disabled: full },
        full ? `${MAX_SOUND_TAKES} takes recorded` : takes.length ? "Record another take" : "Record");
      // Live input level, so a too-quiet take is obvious before it ends.
      const fill = h("div", {});
      const meter = h("div", { class: "meter", hidden: true },
        fill,
        h("div", { class: "quiet-mark", style: `left: ${meterPosition(QUIET_PEAK) * 100}%` }),
      );
      record.addEventListener("click", async () => {
        if (record.dataset.recording) return a.stopRecording();
        record.dataset.recording = "1";
        record.textContent = "Recording… click to stop";
        record.classList.add("danger");
        status.className = "recording";
        status.textContent = "● Recording";
        meter.hidden = false;
        const startedAt = performance.now();
        let loudest = 0;
        await a.recordSound(soundId, ({ peak }) => {
          loudest = Math.max(loudest, peak);
          fill.style.width = `${meterPosition(peak) * 100}%`;
          fill.classList.toggle("loud", peak >= QUIET_PEAK);
          if (performance.now() - startedAt > 600) {
            status.textContent = loudest < QUIET_PEAK ? "● Recording — louder!" : "● Recording";
          }
        });
      });
      root.append(panel("narrow",
        h("p", { class: "muted" }, `Sound ${s.soundIndex + 1} of ${SOUND_IDS.length}`),
        h("h2", {}, prompt.title),
        h("p", {}, prompt.hint),
        status,
        meter,
        ...takes.map((_, i) =>
          h("div", { class: "row" },
            h("button", { type: "button", on: { click: () => a.playSound(soundId, i) } }, `▶ Take ${i + 1}`),
            h("button", { type: "button", class: "danger", on: { click: () => a.removeTake(soundId, i) } }, "Remove"),
          ),
        ),
        record,
        h("div", { class: "row" },
          takes.length
            ? h("button", { type: "button", class: "primary", on: { click: () => a.soundDone() } }, "Next")
            : h("button", { type: "button", on: { click: () => a.skipSound(soundId) } }, "Skip this one"),
          h("button", { type: "button", on: { click: () => a.skipAllSounds() } }, "Skip all sounds"),
        ),
      ));
      break;
    }
    case "preview": {
      const name = h("input", { type: "text", placeholder: "Fighter name", maxLength: MAX_TYPED_NAME_LENGTH, value: data.name });
      name.addEventListener("input", () => a.setName(name.value));
      root.append(h("div", { class: "preview-screen" },
        panel("showcase-panel", showcase(data, flow.archetype!)),
        panel("",
          h("h2", {}, "Ready to fight"),
          name,
          notice,
          h("button", { type: "button", class: "primary big", on: { click: () => { a.setName(name.value); a.finish(); } } }, env.editing ? "Save changes" : "Save fighter"),
          canRetake(flow)
            ? h("details", {},
                h("summary", { class: "muted" }, "Retake a pose"),
                strip(data, flow.archetype, a.retake),
              )
            : null,
        ),
      ));
      break;
    }
    case "saving":
      root.append(panel("narrow", h("h2", {}, "Saving…"), h("p", { class: "muted" }, "Storing your fighter in this browser.")));
      break;
    case "saved":
      root.append(panel("narrow",
        h("h1", {}, "Saved"),
        h("p", {}, env.editing
          ? `${data.name.trim() || "Your fighter"} is updated in the game's roster on this computer (its record stays).`
          : `${data.name.trim() || "Your fighter"} is in the game's roster on this computer.`),
        h("a", { class: "button primary big", href: env.gameUrl }, "Back to the game"),
        h("button", { type: "button", on: { click: () => a.restart() } }, "Build another"),
        h("button", { type: "button", on: { click: () => a.download() } }, "Download fighter file"),
      ));
      break;
    case "error":
      root.append(panel("narrow",
        h("h2", {}, "Something went wrong"),
        h("p", { class: "error" }, s.message),
        h("button", { type: "button", class: "primary", on: { click: () => a.restart() } }, "Start over"),
      ));
      break;
  }
}
