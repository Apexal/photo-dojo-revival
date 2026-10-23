/**
 * Turns key events into per-frame button levels without losing fast taps.
 *
 * - A tap shorter than a frame (down and up between two reads) still reads as
 *   pressed for one frame.
 * - Two taps on consecutive frames would read "held, held" and look like one
 *   press to edge detection, so after a release the next press is shown one
 *   frame later, with a "released" frame in between.
 */
export class TapLatch<A extends string> {
  private readonly latched = new Set<A>();
  private readonly released = new Set<A>();
  private readonly reported = new Set<A>();

  press(action: A): void {
    this.latched.add(action);
  }

  release(action: A): void {
    this.released.add(action);
  }

  /** Level for each action this frame; `isDown` is the key's current physical state. */
  read(actions: readonly A[], isDown: (a: A) => boolean): Record<A, boolean> {
    const out = {} as Record<A, boolean>;
    for (const a of actions) {
      let value: boolean;
      if (this.latched.has(a) && this.reported.has(a) && this.released.has(a)) {
        // A fresh press right after a release we never reported: show the release first.
        value = false;
        this.released.delete(a);
      } else {
        value = this.latched.has(a) || isDown(a);
        this.latched.delete(a);
        this.released.delete(a);
      }
      if (value) this.reported.add(a);
      else this.reported.delete(a);
      out[a] = value;
    }
    return out;
  }
}
