/**
 * The game page is the big-screen half: keyboards and controllers on a laptop
 * or TV. A shared link mostly gets opened on phones, so a phone sees what to
 * do instead (open the game on a computer; this phone is the camera), with a
 * way through for anyone who wants the game anyway.
 */

/** Touch-first and phone-sized (tablets are big enough to host, with a controller). */
export function looksLikePhone(): boolean {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse && Math.min(window.screen.width, window.screen.height) < 600;
}

const SKIP_KEY = "photoDojo.showGameOnPhone";

/** Calls `start` now, or once the visitor picks "show the game anyway". */
export function gatePhones(start: () => void): void {
  let skipped = false;
  try {
    skipped = sessionStorage.getItem(SKIP_KEY) === "1";
  } catch {
    // Storage blocked: just ask again next time.
  }
  if (skipped || !looksLikePhone()) return start();

  const base = import.meta.env.BASE_URL;
  const gate = document.createElement("main");
  gate.id = "phone-gate";
  gate.innerHTML = `
    <h1>Photo Dojo<span>REVIVAL</span></h1>
    <p><strong>The fight happens on a big screen.</strong> Open this page on a laptop or a TV, and play with keyboards or game controllers.</p>
    <p>Your phone is the camera: scan the code the game shows to turn yourself into a fighter. Or start now, and bring your fighter to a game later as a file.</p>
    <a class="button primary" href="${base}capture">Become a fighter</a>
    <button type="button">Show the game anyway</button>
    <p class="muted">Your photos never leave your devices. <a href="${base}about">About, FAQ &amp; credits</a></p>
  `;
  gate.querySelector("button")!.addEventListener("click", () => {
    try {
      sessionStorage.setItem(SKIP_KEY, "1");
    } catch {
      // Fine: it's only for this visit anyway.
    }
    gate.remove();
    start();
  });
  document.body.prepend(gate);
}
