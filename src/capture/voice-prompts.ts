/** How long an utterance may take to start before the speech queue counts as stuck. */
const START_TIMEOUT_MS = 2500;

/**
 * speechSynthesis cues ("punch... hold it... got it"). Silently no-ops where unsupported.
 *
 * Defensive, because a real browser profile is less forgiving than a fresh one:
 * it uses a voice on this computer (network and extension voices can fail
 * without a sound), keeps each utterance referenced (Chrome can drop one it
 * thinks is unused, and the queue then stalls), and if nothing starts in time it
 * clears the queue (shared by every tab in Chrome) and tries once more.
 * Problems are logged with a `[voice]` prefix.
 */
export class VoicePrompts {
  enabled = true;
  private readonly synth: SpeechSynthesis | null = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
  private voice: SpeechSynthesisVoice | null = null;
  /** Utterances queued or speaking: kept referenced until they end. */
  private readonly live = new Set<SpeechSynthesisUtterance>();
  /** When any utterance last started or ended: a queue that's moving, even if this line waits its turn. */
  private lastProgressAt = -Infinity;

  constructor() {
    if (!this.synth) return;
    this.pickVoice();
    this.synth.addEventListener?.("voiceschanged", () => this.pickVoice());
  }

  get supported(): boolean {
    return this.synth !== null;
  }

  /** The voice in use, for diagnostics. */
  get voiceName(): string | null {
    return this.voice?.name ?? null;
  }

  say(text: string, options: { interrupt?: boolean } = {}): void {
    if (!this.enabled || !this.synth) return;
    if (options.interrupt ?? true) this.clear();
    this.speak(text, true);
  }

  /** iOS only speaks after a user gesture; call this from one to unlock. */
  unlock(): void {
    if (!this.synth) return;
    // A word, not a space: some engines skip whitespace without ever starting, which doesn't unlock anything.
    const u = this.utterance("ready");
    u.volume = 0;
    this.synth.speak(u);
  }

  private speak(text: string, retry: boolean): void {
    const synth = this.synth!;
    const u = this.utterance(text);
    let started = false;
    u.addEventListener("start", () => { started = true; });
    u.addEventListener("error", (e) => {
      // "interrupted"/"canceled" are ours (a newer line cut it off).
      if (e.error !== "interrupted" && e.error !== "canceled") console.warn(`[voice] couldn't say "${text}": ${e.error} (voice: ${this.voiceName ?? "default"})`);
    });
    synth.speak(u);
    // Queued behind other lines is fine; only a queue that isn't moving at all is stuck.
    window.setTimeout(() => {
      const moving = synth.speaking && performance.now() - this.lastProgressAt < START_TIMEOUT_MS;
      if (started || !this.live.has(u) || moving) return;
      console.warn(`[voice] "${text}" didn't start (speaking=${synth.speaking}, pending=${synth.pending}, paused=${synth.paused}, voice: ${this.voiceName ?? "default"})${retry ? "; clearing the queue and trying again" : ""}`);
      if (!retry) return;
      this.clear();
      synth.resume();
      this.speak(text, false);
    }, START_TIMEOUT_MS);
  }

  private utterance(text: string): SpeechSynthesisUtterance {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    if (this.voice) {
      u.voice = this.voice;
      u.lang = this.voice.lang;
    }
    this.live.add(u);
    const progress = () => { this.lastProgressAt = performance.now(); };
    const done = () => { this.live.delete(u); progress(); };
    u.addEventListener("start", progress);
    u.addEventListener("end", done);
    u.addEventListener("error", done);
    return u;
  }

  private clear(): void {
    this.synth?.cancel();
    this.live.clear();
  }

  /** The default voice if it's on this computer, else the first local one in the page's language, else English. */
  private pickVoice(): void {
    const voices = this.synth?.getVoices() ?? [];
    if (!voices.length) return;
    const lang = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2).toLowerCase();
    const local = voices.filter((v) => v.localService);
    const inLang = (code: string) => (v: SpeechSynthesisVoice) => v.lang.toLowerCase().startsWith(code);
    this.voice = local.find((v) => v.default && inLang(lang)(v))
      ?? local.find(inLang(lang))
      ?? local.find(inLang("en"))
      ?? null; // nothing local: leave it to the browser's default
  }
}
