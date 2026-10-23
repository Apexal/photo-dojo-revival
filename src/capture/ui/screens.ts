import { ARCHETYPES, ARCHETYPE_IDS, type ArchetypeId } from "../../shared/archetypes";
import { MAX_SOUND_SECONDS, MAX_SOUND_TAKES, SOUND_IDS, type PoseId, type SoundId } from "../../shared/fighter-model";
import { CAPTURE_TARGET_COUNT, SIGNATURE_DEFINITIONS, captureTargetsFor } from "../../shared/pose-definitions";
import { describeAge, type DraftSummary } from "../capture-draft";
import type { CaptureFlowState, CaptureMode } from "../capture-flow";
import type { CaptureSessionData } from "../main";
import { QUIET_PEAK, meterPosition, playClip, type AudioLevel } from "../sound-recorder";
import { clear, h } from "./dom";

export interface ScreenActions {
  selectMode(mode: CaptureMode): void;
  setRoomCode(code: string): void;
  resumeDraft(): void;
  discardDraft(): void;
  setVoice(enabled: boolean): void;
  start(): void;
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
  retrySend(): void;
  download(): void;
  downloadDebug(): void;
  restart(): void;
}

export interface ScreenEnv {
  video: HTMLVideoElement;
  mirrored: boolean;
  /** Model download progress (0..1) for the loading screen. */
  loadProgress: number;
  /** More than one camera: offer the front/rear switch. */
  canSwitchCamera: boolean;
  onOverlay(canvas: HTMLCanvasElement): void;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  recordingSupported: boolean;
  /** `?debug=1`: offer the matting debug export. */
  debug: boolean;
  /** A saved, unfinished capture that can be resumed. */
  draft: DraftSummary | null;
}

const SOUND_PROMPTS: Record<SoundId, { title: string; hint: string }> = {
  attack: { title: "Battle cry", hint: "Plays when you punch or kick. “Hyah!”" },
  hurt: { title: "Ouch", hint: "Plays when you get hit." },
  win: { title: "Victory line", hint: "Plays when you win a round." },
};

const screen = (...children: (Node | string | null | false)[]) => h("section", { class: "screen" }, ...children);

/** All sixteen poses. Tapping one retakes it. */
function strip(data: CaptureSessionData, archetype: ArchetypeId, onPick?: (targetKey: string) => void): HTMLElement {
  return h("div", { class: "strip" },
    ...captureTargetsFor(archetype).map((t) =>
      h("button", { type: "button", disabled: !onPick, on: { click: () => onPick?.(t.key) } },
        data.previews[t.key] ? h("img", { src: data.previews[t.key], alt: t.key }) : h("div", { class: "muted" }, "—"),
        t.definition.label,
      ),
    ),
  );
}

const randomTake = (data: CaptureSessionData, id: SoundId) => {
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
function showcase(data: CaptureSessionData, archetype: ArchetypeId): HTMLCanvasElement {
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
  return progress < 1 ? `Downloading models… ${Math.round(progress * 100)}%` : "Starting the camera and the models…";
}

export function renderScreen(root: HTMLElement, flow: CaptureFlowState, data: CaptureSessionData, a: ScreenActions, env: ScreenEnv): void {
  const s = flow.screen;
  clear(root);
  const roomInfo = flow.roomCode
    ? h("p", { class: "room" }, "Sending to game ", h("strong", {}, flow.roomCode))
    : h("p", { class: "room muted" }, "No game code: your fighter will be saved on this phone.");

  switch (s.name) {
    case "intro": {
      const code = h("input", { type: "text", placeholder: "Game code (optional)", maxLength: 6, autocapitalize: "characters", value: flow.roomCode ?? "" });
      code.addEventListener("change", () => a.setRoomCode(code.value));
      root.append(screen(
        h("h1", {}, "Photo Dojo", h("span", { class: "kicker" }, "Revival")),
        env.draft
          ? h("div", { class: "resume" },
              h("strong", {}, "Pick up where you left off?"),
              h("p", { class: "muted" }, `${env.draft.captured} of ${CAPTURE_TARGET_COUNT} poses captured · ${describeAge(env.draft.ageMs)}`),
              h("div", { class: "row" },
                h("button", { type: "button", class: "primary", on: { click: () => a.resumeDraft() } }, "Resume"),
                h("button", { type: "button", on: { click: () => a.discardDraft() } }, "Start fresh"),
              ),
            )
          : null,
        h("p", {}, `Strike ${CAPTURE_TARGET_COUNT} poses, record ${SOUND_IDS.length} battle cries, and become a fighter.`),
        roomInfo,
        flow.roomCode ? null : code,
        h("div", { class: "choices" },
          h("button", { type: "button", class: "primary", on: { click: () => a.selectMode("friend") } },
            "Friend holds the phone", h("small", {}, "Someone else points the camera at you.")),
          h("button", { type: "button", on: { click: () => a.selectMode("solo") } },
            "Solo, phone propped up", h("small", {}, "Bigger text and a pause after each pose to get back in position.")),
        ),
        env.voiceSupported
          ? h("label", { class: "check" },
              h("input", { type: "checkbox", checked: env.voiceEnabled, on: { change: (ev) => a.setVoice((ev.target as HTMLInputElement).checked) } }),
              "Spoken prompts")
          : null,
        h("p", { class: "privacy" },
          h("strong", {}, "Private by design. "),
          "Your photos and voice are processed on this phone and go straight to the game screen, nowhere else: no accounts, no uploads. There's no cloud backup either, so keep a downloaded copy of fighters you love."),
        h("p", { class: "muted" }, h("a", { href: `${import.meta.env.BASE_URL}about`, target: "_blank", rel: "noopener" }, "About, FAQ & credits")),
      ));
      break;
    }
    case "tips":
      root.append(screen(
        h("h2", {}, "Before you start"),
        h("ul", { class: "tips" },
          h("li", {}, "Stand in front of a plain wall."),
          h("li", {}, "Get your whole body in the frame, head to feet (about 3–4 m back)."),
          h("li", {}, "Stand sideways, facing to your right."),
          h("li", {}, "Match the white ghost. Hold still when it turns green."),
        ),
        h("button", { type: "button", class: "primary", on: { click: () => a.start() } }, "Start camera"),
      ));
      break;
    case "loading":
      root.append(screen(
        h("h2", {}, "Warming up…"),
        h("p", { class: "muted", dataset: { loadStatus: "" } }, loadStatusText(env.loadProgress)),
        h("div", { class: "progress" }, h("div", { dataset: { loadProgress: "" }, style: `width: ${Math.round(env.loadProgress * 100)}%` })),
        h("p", { class: "muted" }, "The first time, this downloads about 250 MB of pose and background-removal models (best on Wi-Fi). After that they're stored on this device and load in seconds."),
      ));
      break;
    case "pose":
    case "captured": {
      const overlay = h("canvas", { class: "overlay" });
      env.onOverlay(overlay);
      root.append(h("div", { class: `capture${env.mirrored ? " mirrored" : ""}${flow.mode === "solo" ? " large" : ""}` },
        h("div", { class: "viewport" },
          env.video,
          overlay,
          h("div", { class: "hud" },
            h("div", { class: "step", dataset: { hud: "step" } }),
            h("div", { class: "label", dataset: { hud: "label" } }),
            h("div", { class: "hint", dataset: { hud: "hint" } }),
          ),
          h("img", { class: "cutout", dataset: { hud: "cutout" }, hidden: true, alt: "" }),
        ),
        h("div", { class: "controls" },
          h("button", { type: "button", class: "primary", dataset: { hud: "manual" }, hidden: true, on: { click: () => a.manualCapture() } }, "Tap to capture anyway"),
          h("button", { type: "button", class: "primary", dataset: { hud: "rough-retake" }, hidden: true, on: { click: () => a.retakeRough() } }, "Retake"),
          h("button", { type: "button", dataset: { hud: "rough-keep" }, hidden: true, on: { click: () => a.keepRough() } }, "Keep it"),
          env.canSwitchCamera
            ? h("button", { type: "button", class: "switch", title: "Switch camera", "aria-label": "Switch camera", dataset: { hud: "switch" }, on: { click: () => a.switchCamera() } }, "⇄ Camera")
            : null,
        ),
      ));
      void env.video.play().catch(() => {});
      break;
    }
    case "archetype":
      root.append(screen(
        h("h2", {}, "Pick your fighting style"),
        h("p", { class: "muted" }, "It gives you one signature move (down + punch + kick), and it's your next pose."),
        h("div", { class: "choices archetypes" },
          ...ARCHETYPE_IDS.map((id) =>
            h("button", { type: "button", class: id === flow.archetype ? "primary" : "", on: { click: () => a.pickArchetype(id) } },
              ghost(SIGNATURE_DEFINITIONS[id].ghostSvgPath),
              h("span", {}, `${ARCHETYPES[id].name}: ${ARCHETYPES[id].moveName}`, h("small", {}, ARCHETYPES[id].blurb)),
            ),
          ),
        ),
      ));
      break;
    case "review":
      root.append(screen(
        h("h2", {}, "Your moves"),
        h("p", { class: "muted" }, "Tap a pose to retake it."),
        strip(data, flow.archetype!, a.retake),
        h("button", { type: "button", on: { click: () => a.changeArchetype() } }, `Style: ${ARCHETYPES[flow.archetype!].name} · change`),
        h("button", { type: "button", class: "primary", on: { click: () => a.reviewDone() } }, "Looks good"),
        env.debug ? h("button", { type: "button", on: { click: () => a.downloadDebug() } }, "Download matting debug (zip)") : null,
      ));
      break;
    case "sounds": {
      const soundId = SOUND_IDS[s.soundIndex];
      const prompt = SOUND_PROMPTS[soundId];
      const takes = data.sounds[soundId] ?? [];
      const full = takes.length >= MAX_SOUND_TAKES;
      const status = h("p", { class: "muted" },
        takes.length ? `${takes.length} take${takes.length > 1 ? "s" : ""}. The game picks one at random each time.` : `Tap record and shout. Stops after ${MAX_SOUND_SECONDS[soundId]} seconds.`);
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
        record.textContent = "Recording… tap to stop";
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
          // Give them a moment to start before nagging.
          if (performance.now() - startedAt > 600) {
            status.textContent = loudest < QUIET_PEAK ? "● Recording — louder!" : "● Recording";
          }
        });
      });
      root.append(screen(
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
      const name = h("input", { type: "text", placeholder: "Fighter name", maxLength: 24, value: data.name });
      name.addEventListener("input", () => a.setName(name.value));
      root.append(screen(
        h("h2", {}, "Ready to fight"),
        showcase(data, flow.archetype!),
        name,
        roomInfo,
        h("button", { type: "button", class: "primary", on: { click: () => { a.setName(name.value); a.finish(); } } },
          flow.roomCode ? "Send to game" : "Save"),
        h("details", {},
          h("summary", { class: "muted" }, "Retake a pose"),
          strip(data, flow.archetype!, a.retake),
        ),
      ));
      break;
    }
    case "sending":
      root.append(screen(
        h("h2", {}, "Sending to the game…"),
        h("p", { class: "muted" }, "Saved on this phone. Connecting to the laptop."),
        h("div", { class: "progress" }, h("div", { dataset: { progress: "" } })),
      ));
      break;
    case "sent":
      root.append(screen(
        h("h1", {}, "Sent!"),
        h("p", {}, "Look at the laptop — your fighter is in the roster."),
        h("button", { type: "button", on: { click: () => a.download() } }, "Download fighter file"),
        h("button", { type: "button", class: "primary", on: { click: () => a.restart() } }, "Capture another fighter"),
      ));
      break;
    case "saved":
      root.append(screen(
        h("h1", {}, "Saved"),
        h("p", {}, "Your fighter is saved in this browser. Download the file to import it on the game screen."),
        h("button", { type: "button", class: "primary", on: { click: () => a.download() } }, "Download fighter file"),
        h("button", { type: "button", on: { click: () => a.restart() } }, "Capture another fighter"),
      ));
      break;
    case "sendFailed": {
      const code = h("input", { type: "text", placeholder: "New game code (if the laptop restarted)", maxLength: 6, autocapitalize: "characters" });
      root.append(screen(
        h("h2", {}, "Couldn't reach the game"),
        h("p", { class: "error" }, s.reason),
        h("p", { class: "muted" }, "Your fighter is saved on this phone. If the laptop shows a different code now, enter it and try again — or download the file and use “Import fighter file” on the laptop."),
        code,
        h("button", { type: "button", class: "primary", on: { click: () => { if (code.value.trim()) a.setRoomCode(code.value); a.retrySend(); } } }, "Try again"),
        h("button", { type: "button", on: { click: () => a.download() } }, "Download fighter file"),
      ));
      break;
    }
    case "error":
      root.append(screen(
        h("h2", {}, "Something went wrong"),
        h("p", { class: "error" }, s.message),
        h("button", { type: "button", class: "primary", on: { click: () => a.restart() } }, "Start over"),
      ));
      break;
  }
}
