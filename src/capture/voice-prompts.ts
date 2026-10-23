/** speechSynthesis cues ("punch... hold it... got it"). Silently no-ops where unsupported. */
export class VoicePrompts {
  enabled = true;
  private readonly synth: SpeechSynthesis | null = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;

  get supported(): boolean {
    return this.synth !== null;
  }

  say(text: string, options: { interrupt?: boolean } = {}): void {
    if (!this.enabled || !this.synth) return;
    if (options.interrupt ?? true) this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    this.synth.speak(u);
  }

  /** iOS only speaks after a user gesture; call this from one to unlock. */
  unlock(): void {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    this.synth.speak(u);
  }
}

export function vibrate(pattern: number | number[] = 60): void {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
}
