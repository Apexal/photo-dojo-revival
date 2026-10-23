/**
 * Fullscreen for the whole page (the game and, on fighter select, the toolbar
 * under it). Browsers only allow entering it from a click or key press.
 */

interface KeyboardLock {
  lock?(keys: string[]): Promise<void>;
  unlock?(): void;
}
const keyboard = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;

export const isFullscreen = () => document.fullscreenElement !== null && document.fullscreenElement !== undefined;
export const canFullscreen = () => typeof document.documentElement.requestFullscreen === "function" && document.fullscreenEnabled;

export async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) return document.exitFullscreen();
  if (!canFullscreen()) return;
  await document.documentElement.requestFullscreen();
  // Esc pauses a fight. Where the browser can lock it (Chrome, Edge), it still does, and holding Esc leaves
  // fullscreen; elsewhere a press leaves fullscreen and the game doesn't see it.
  await keyboard()?.lock?.(["Escape"]).catch(() => {});
}

/** Calls `onChange` now and whenever fullscreen starts or ends; returns the unsubscribe. */
export function watchFullscreen(onChange: (on: boolean) => void): () => void {
  const handler = () => onChange(isFullscreen());
  document.addEventListener("fullscreenchange", handler);
  handler();
  return () => document.removeEventListener("fullscreenchange", handler);
}
