import { DEFAULT_ENVELOPE, DEFAULT_TALK, dropJaw, jawDropFor, loudnessEnvelope, maxJawDrop, mouthFrameOf, mouthHole, opennessAt, type MouthFrame } from "../game/render/talking-mouth";
import { drawMouthHole } from "../game/render/talking-mouth-view";
import { trimLeadingSilence } from "../shared/audio-trim";
import { context2d } from "../shared/canvas";
import { SOUND_IDS, SPRITE_CANVAS_SIZE, soundTakes, type Fighter, type NormalizedLandmark } from "../shared/fighter-model";
import { listFighters } from "../shared/fighter-storage";
import { h } from "../studio/ui/dom";

/**
 * The pose lab's talking-mouth bench: a fighter's photo (or the lab's own cut-out)
 * talking along to a voice clip (talking-mouth.ts), with its knobs.
 */

/** A photo to put a mouth on: a 512² sprite and its landmarks in sprite pixels. */
export interface TalkingFace { label: string; sprite: Blob; landmarks: NormalizedLandmark[] }

interface Clip { label: string; blob: Blob }

const VIEW = 480;

function slider(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLElement {
  const out = h("span", {}, String(value));
  const input = h("input", { type: "range", min, max, step, value, on: { input: () => { out.textContent = input.value; onInput(Number(input.value)); } } });
  return h("label", { class: "field" }, h("span", {}, label), input, out);
}

export class TalkingBench {
  readonly element = h("section", { class: "talking" });
  private fighters: Fighter[] = [];
  private faces: TalkingFace[] = [];
  private clips: Clip[] = [];
  private face: TalkingFace | null = null;
  private faceIndex = 0;
  private clipIndex = 0;
  private uploadedClip: Clip | null = null;

  private rgba: Uint8ClampedArray | null = null;
  private frame: MouthFrame | null = null;
  private envelope: Float32Array | null = null;
  private buffer: AudioBuffer | null = null;
  private ctx: AudioContext | null = null;
  private playing: { source: AudioBufferSourceNode; startedAt: number } | null = null;
  private manualOpen = 0;

  private options = { ...DEFAULT_ENVELOPE, zoom: true, loop: false };
  private talk = { ...DEFAULT_TALK };

  private readonly faceSelect = h("select", { on: { change: () => void this.pickFace(Number(this.faceSelect.value)) } });
  private readonly clipSelect = h("select", { on: { change: () => void this.pickClip(Number(this.clipSelect.value)) } });
  private readonly playButton = h("button", { class: "primary", on: { click: () => void this.togglePlay() } }, "▶ Play");
  private readonly view = h("canvas", { width: VIEW, height: VIEW });
  private readonly graph = h("canvas", { width: VIEW, height: 70 });
  private readonly note = h("p", { class: "hint" });
  private readonly work = document.createElement("canvas");

  constructor(private readonly labFace: () => TalkingFace | null) {
    this.work.width = this.work.height = SPRITE_CANVAS_SIZE;
    const file = h("input", { type: "file", accept: "audio/*", hidden: true, on: { change: () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      this.uploadedClip = { label: `File: ${f.name}`, blob: f };
      this.fillClips();
      void this.pickClip(this.clips.length - 1);
    } } });
    const redo = () => { this.computeEnvelope(); this.draw(); };
    this.element.append(
      h("h2", {}, "Talking mouth"),
      h("div", { class: "row" },
        this.faceSelect, this.clipSelect, this.playButton,
        h("button", { on: { click: () => file.click() } }, "Open audio…"), file,
        h("button", { on: { click: () => void this.refresh() } }, "Reload fighters"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: this.options.zoom, on: { change: (e) => { this.options.zoom = (e.target as HTMLInputElement).checked; this.draw(); } } }), "Close-up"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: this.options.loop, on: { change: (e) => { this.options.loop = (e.target as HTMLInputElement).checked; } } }), "Loop")),
      h("div", { class: "pair" },
        h("figure", {}, this.view, this.graph, this.note),
        h("div", { class: "knobs" },
          slider("Open by hand", 0, 0, 1, 0.01, (v) => { this.manualOpen = v; this.draw(); }),
          slider("Jaw drop, head sizes", this.talk.drop, 0.05, 1, 0.01, (v) => { this.talk.drop = v; this.describe(); this.draw(); }),
          slider("Quiet opens wider (curve)", this.talk.curve, 0.3, 2, 0.05, (v) => { this.talk.curve = v; this.draw(); }),
          slider("Gate, dB", this.options.gateDb, -60, -6, 1, (v) => { this.options.gateDb = v; redo(); }),
          slider("Syllables, dB", this.options.syllableDb, 0, 20, 0.5, (v) => { this.options.syllableDb = v; redo(); }),
          slider("Syllable reach, ms", this.options.syllableMs, 20, 400, 10, (v) => { this.options.syllableMs = v; redo(); }),
          slider("Opening, ms", this.options.attackMs, 1, 150, 1, (v) => { this.options.attackMs = v; redo(); }),
          slider("Closing, ms", this.options.releaseMs, 1, 400, 1, (v) => { this.options.releaseMs = v; redo(); }))),
    );
    void this.refresh();
  }

  /** Fighters from IndexedDB (the game's, on this origin), plus the lab's latest cut-out. */
  async refresh(): Promise<void> {
    try {
      this.fighters = await listFighters();
    } catch (err) {
      console.warn("[lab] fighters", err);
      this.fighters = [];
    }
    this.faces = [];
    const lab = this.labFace();
    if (lab) this.faces.push(lab);
    for (const fighter of this.fighters) {
      for (const [poseId, pose] of Object.entries(fighter.poses)) this.faces.push({ label: `${fighter.name} · ${poseId}`, sprite: pose.imageBlob, landmarks: pose.landmarks });
      for (const [poseId, variants] of Object.entries(fighter.poseVariants)) {
        variants?.forEach((pose, i) => this.faces.push({ label: `${fighter.name} · ${poseId}-${i + 2}`, sprite: pose.imageBlob, landmarks: pose.landmarks }));
      }
    }
    this.faceSelect.replaceChildren(...this.faces.map((f, i) => h("option", { value: i }, f.label)));
    if (!this.faces.length) {
      this.note.textContent = "No fighters saved on this origin yet, and no cut-out in the lab: build one in the studio, or take a snapshot above.";
      return;
    }
    await this.pickFace(Math.min(this.faceIndex, this.faces.length - 1));
  }

  private async pickFace(index: number): Promise<void> {
    this.faceIndex = index;
    this.faceSelect.value = String(index);
    const face = this.faces[index];
    this.face = face;
    const bitmap = await createImageBitmap(face.sprite);
    const ctx = context2d(this.work);
    ctx.clearRect(0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
    ctx.drawImage(bitmap, 0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE);
    bitmap.close();
    if (this.face !== face) return;
    this.rgba = ctx.getImageData(0, 0, SPRITE_CANVAS_SIZE, SPRITE_CANVAS_SIZE).data;
    this.frame = mouthFrameOf(face.landmarks);
    this.fillClips();
    this.describe();
    this.draw();
  }

  /** The voice clips of the face's fighter (all of them when it's the lab's cut-out), and any opened file. */
  private fillClips(): void {
    const owner = this.fighters.find((f) => this.face?.label.startsWith(`${f.name} · `));
    const from = owner ? [owner] : this.fighters;
    this.clips = from.flatMap((f) => SOUND_IDS.flatMap((id) => soundTakes(f, id).map((blob, i) => ({ label: `${owner ? "" : `${f.name} · `}${id}${i ? ` ${i + 1}` : ""}`, blob }))));
    if (this.uploadedClip) this.clips.push(this.uploadedClip);
    this.clipSelect.replaceChildren(...this.clips.map((c, i) => h("option", { value: i }, c.label)));
    if (this.clips.length) void this.pickClip(Math.min(this.clipIndex, this.clips.length - 1));
  }

  private async pickClip(index: number): Promise<void> {
    this.stop();
    this.clipIndex = index;
    this.clipSelect.value = String(index);
    const clip = this.clips[index];
    if (!clip) return;
    try {
      this.ctx ??= new AudioContext();
      // Trimmed like the game plays it, so the mouth keeps time with what's heard.
      this.buffer = trimLeadingSilence(this.ctx, await this.ctx.decodeAudioData(await clip.blob.arrayBuffer()));
      this.computeEnvelope();
    } catch (err) {
      this.buffer = this.envelope = null;
      this.note.textContent = `Couldn't decode ${clip.label}: ${(err as Error).message}`;
    }
    this.draw();
  }

  private computeEnvelope(): void {
    if (!this.buffer) return;
    const channels = Array.from({ length: this.buffer.numberOfChannels }, (_, i) => this.buffer!.getChannelData(i));
    this.envelope = loudnessEnvelope(channels, this.buffer.sampleRate, this.options);
  }

  private async togglePlay(): Promise<void> {
    if (this.playing) return this.stop();
    if (!this.buffer || !this.ctx) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.ctx.destination);
    source.loop = this.options.loop;
    source.start();
    this.playing = { source, startedAt: this.ctx.currentTime };
    source.onended = () => { if (this.playing?.source === source) this.stop(); };
    this.playButton.textContent = "■ Stop";
    const tick = () => {
      if (this.playing?.source !== source) return;
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private stop(): void {
    const p = this.playing;
    this.playing = null;
    if (p) {
      p.source.onended = null;
      try { p.source.stop(); } catch { /* already ended */ }
    }
    this.playButton.textContent = "▶ Play";
    this.draw();
  }

  /** Seconds into the clip (looping wraps), or null when it isn't playing. */
  private playhead(): number | null {
    if (!this.playing || !this.ctx || !this.buffer) return null;
    const t = this.ctx.currentTime - this.playing.startedAt;
    return this.options.loop ? t % this.buffer.duration : t;
  }

  private describe(): void {
    const f = this.frame;
    this.note.textContent = !f
      ? "No face found in this photo (nose, eye or ear not seen clearly): nothing to put a mouth on."
      : `${f.frontal ? "Face turned to the camera: both mouth corners" : "Side-on: one mouth corner, width guessed"} · head ${f.headSize.toFixed(0)} px · mouth ${f.width.toFixed(0)} px · jaw drop ${Math.min(maxJawDrop(f), this.talk.drop * f.headSize).toFixed(0)} px (most the neck allows: ${maxJawDrop(f).toFixed(0)})`;
  }

  private draw(): void {
    const t = this.playhead();
    const open = t === null || !this.envelope ? this.manualOpen : opennessAt(this.envelope, this.options.fps, t);
    this.drawGraph(t);
    const f = this.frame;
    if (!this.rgba) return;
    const size = SPRITE_CANVAS_SIZE;
    const ctx = context2d(this.work);
    const drop = f ? jawDropFor(f, open, this.talk) : 0;
    ctx.putImageData(new ImageData(f ? dropJaw(this.rgba, size, size, f, drop) : new Uint8ClampedArray(this.rgba), size, size), 0, 0);
    const hole = f && mouthHole(f, drop);
    if (f && hole) drawMouthHole(ctx, hole, f);
    this.blit(this.view, f);
  }

  /** The work canvas onto a view: the head close up, or the whole sprite. */
  private blit(view: HTMLCanvasElement, f: MouthFrame | null): void {
    const ctx = context2d(view);
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.imageSmoothingQuality = "high";
    if (this.options.zoom && f) {
      const side = 4.2 * f.headSize;
      const cx = f.center.x + f.up.x * 0.4 * f.headSize, cy = f.center.y + f.up.y * 0.4 * f.headSize;
      ctx.drawImage(this.work, cx - side / 2, cy - side / 2, side, side, 0, 0, VIEW, VIEW);
    } else {
      ctx.drawImage(this.work, 0, 0, VIEW, VIEW);
    }
  }

  private drawGraph(t: number | null): void {
    const ctx = context2d(this.graph);
    const { width: W, height: H } = this.graph;
    ctx.clearRect(0, 0, W, H);
    const env = this.envelope;
    if (!env?.length) return;
    ctx.fillStyle = "#ffc83d55";
    ctx.beginPath();
    ctx.moveTo(0, H);
    env.forEach((v, i) => ctx.lineTo((i / env.length) * W, H - v * (H - 4)));
    ctx.lineTo(W, H);
    ctx.fill();
    if (t !== null && this.buffer) {
      ctx.fillStyle = "#fff4dc";
      ctx.fillRect((t / this.buffer.duration) * W - 1, 0, 2, H);
    }
  }
}
