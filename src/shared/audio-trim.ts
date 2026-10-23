/** Analysis window for finding where a voice line actually starts. */
export const TRIM_WINDOW_MS = 5;
/** Keep a little lead-in so the attack of the first syllable isn't clipped. */
export const TRIM_PRE_ROLL_MS = 15;
/** A window is "sound" when its RMS reaches this absolute level, or this fraction of the clip's peak RMS. */
export const TRIM_ABSOLUTE_THRESHOLD = 0.02;
export const TRIM_RELATIVE_THRESHOLD = 0.1;

/**
 * Number of samples of leading silence to drop: everything before the first
 * window whose RMS (across channels) is above the threshold, minus a short
 * pre-roll. Returns 0 for clips that are silent throughout.
 */
export function leadingSilenceSamples(
  channels: Float32Array[],
  sampleRate: number,
  options: { windowMs?: number; preRollMs?: number; absoluteThreshold?: number; relativeThreshold?: number } = {},
): number {
  const {
    windowMs = TRIM_WINDOW_MS,
    preRollMs = TRIM_PRE_ROLL_MS,
    absoluteThreshold = TRIM_ABSOLUTE_THRESHOLD,
    relativeThreshold = TRIM_RELATIVE_THRESHOLD,
  } = options;
  const length = channels[0]?.length ?? 0;
  if (!length) return 0;
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const rms: number[] = [];
  for (let start = 0; start < length; start += win) {
    const end = Math.min(length, start + win);
    let sum = 0;
    for (const data of channels) for (let i = start; i < end; i++) sum += data[i] * data[i];
    rms.push(Math.sqrt(sum / ((end - start) * channels.length)));
  }
  const threshold = Math.max(absoluteThreshold, relativeThreshold * Math.max(...rms));
  const first = rms.findIndex((v) => v >= threshold);
  if (first <= 0) return 0;
  return Math.max(0, first * win - Math.round((preRollMs / 1000) * sampleRate));
}

/** A copy of the buffer without its leading silence (the same buffer if there's nothing to cut). */
export function trimLeadingSilence(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const offset = leadingSilenceSamples(channels, buffer.sampleRate);
  if (offset === 0 || offset >= buffer.length) return buffer;
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length - offset, buffer.sampleRate);
  channels.forEach((data, i) => out.copyToChannel(data.subarray(offset), i));
  return out;
}
