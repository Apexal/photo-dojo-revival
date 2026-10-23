import { leadingSilenceSamples, trimLeadingSilence } from "../shared/audio-trim";
import { MAX_SOUND_SECONDS } from "../shared/fighter-model";

export const PREFERRED_AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
export const TARGET_PEAK = 0.9;
export const MAX_GAIN = 10;
/** A take whose peak stays below this needs more than MAX_GAIN to normalize: it'll come out quiet and noisy. */
export const QUIET_PEAK = TARGET_PEAK / MAX_GAIN;

export interface AudioLevel { rms: number; peak: number }

export function measureLevel(samples: Float32Array): AudioLevel {
  let sum = 0, peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak };
}

/** 0..1 position on a level meter for an amplitude, on a dBFS scale from `floorDb` to 0. */
export function meterPosition(amplitude: number, floorDb = -48): number {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude);
  return Math.min(1, Math.max(0, 1 - db / floorDb));
}

/** First supported container; Safari records audio/mp4 instead of webm. */
export function pickRecorderMimeType(isSupported: (type: string) => boolean): string {
  return PREFERRED_AUDIO_TYPES.find((t) => isSupported(t)) ?? "";
}

/** Gain that brings the loudest sample to the target peak, capped so silence isn't amplified into noise. */
export function computePeakGain(channels: Float32Array[], targetPeak = TARGET_PEAK, maxGain = MAX_GAIN): number {
  let peak = 0;
  for (const data of channels) for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak <= 1e-4) return 1;
  return Math.min(maxGain, targetPeak / peak);
}

function recordStream(stream: MediaStream, mimeType: string, maxMs: number, onStart?: (stop: () => void) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error("Recording failed"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
    const stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    const timer = setTimeout(stop, maxMs);
    recorder.addEventListener("stop", () => clearTimeout(timer));
    recorder.start();
    onStart?.(stop);
  });
}

/** MediaRecorder for the three voice clips: one tap to start, auto-stop at 2 s. */
export class SoundRecorder {
  private stopCurrent: (() => void) | null = null;
  private meter: { ctx: AudioContext; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer> } | null = null;
  readonly mimeType: string;

  private constructor(private readonly stream: MediaStream) {
    this.mimeType = pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t));
  }

  static isSupported(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  static async open(): Promise<SoundRecorder> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true }, video: false });
    return new SoundRecorder(stream);
  }

  /** Records up to 2 s (or until stop()) and returns a peak-normalized clip. `onLevel` gets the live input level each frame. */
  async record(maxMs = MAX_SOUND_SECONDS * 1000, onLevel?: (level: AudioLevel) => void): Promise<Blob> {
    const stopMeter = onLevel ? this.startMeter(onLevel) : null;
    let raw: Blob;
    try {
      raw = await recordStream(this.stream, this.mimeType, maxMs, (stop) => { this.stopCurrent = stop; });
    } finally {
      stopMeter?.();
      this.stopCurrent = null;
    }
    return normalizePeak(raw, this.mimeType).catch((err) => {
      console.warn("[sound] normalization failed, keeping raw clip", err);
      return raw;
    });
  }

  /** Polls an analyser on the mic stream once per animation frame. Metering is best-effort: no Web Audio, no meter. */
  private startMeter(onLevel: (level: AudioLevel) => void): () => void {
    try {
      if (!this.meter) {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(this.stream).connect(analyser);
        this.meter = { ctx, analyser, samples: new Float32Array(analyser.fftSize) };
      }
    } catch (err) {
      console.warn("[sound] level meter unavailable", err);
      return () => {};
    }
    const { ctx, analyser, samples } = this.meter;
    if (ctx.state === "suspended") void ctx.resume();
    let active = true;
    const tick = () => {
      if (!active) return;
      analyser.getFloatTimeDomainData(samples);
      onLevel(measureLevel(samples));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { active = false; };
  }

  stop(): void {
    this.stopCurrent?.();
  }

  close(): void {
    this.stop();
    void this.meter?.ctx.close();
    this.meter = null;
    this.stream.getTracks().forEach((t) => t.stop());
  }
}

/**
 * Normalize peak gain and drop leading silence with Web Audio: decode, compute
 * gain and start offset, and re-record the clip through a GainNode (in real
 * time; clips are ≤2 s). Re-recording can add a few ms of startup silence back,
 * so playback trims again (see audio-trim.ts).
 */
export async function normalizePeak(blob: Blob, mimeType: string): Promise<Blob> {
  const ctx = new AudioContext();
  try {
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const gain = computePeakGain(channels);
    const offset = leadingSilenceSamples(channels, buffer.sampleRate) / buffer.sampleRate;
    if (Math.abs(gain - 1) < 0.05 && offset < 0.03) return blob;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    const destination = ctx.createMediaStreamDestination();
    source.connect(gainNode).connect(destination);
    const done = recordStream(destination.stream, mimeType, (buffer.duration - offset) * 1000 + 150);
    source.start(0, offset);
    return await done;
  } finally {
    void ctx.close();
  }
}

let previewContext: AudioContext | null = null;

/** Play a clip once (review/preview screens), without its leading silence. */
export async function playClip(blob: Blob | null | undefined): Promise<void> {
  if (!blob) return;
  try {
    previewContext ??= new AudioContext();
    const ctx = previewContext;
    if (ctx.state === "suspended") await ctx.resume();
    const buffer = trimLeadingSilence(ctx, await ctx.decodeAudioData(await blob.arrayBuffer()));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  } catch {
    // Undecodable in this browser: fall back to an <audio> element.
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    void audio.play().catch(() => URL.revokeObjectURL(url));
  }
}
