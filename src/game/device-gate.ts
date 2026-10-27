/**
 * The game page and the Character Studio are the big-screen half: keyboards
 * and controllers on a laptop or TV, and the computer that builds fighters. A
 * shared link mostly gets opened on phones, so a phone sees what to do
 * instead (open the game on a computer; this phone can be the studio's
 * camera), with a way through to the game for anyone who wants it anyway.
 */

/** Touch-first and phone-sized (tablets are big enough to host, with a controller). */
export function looksLikePhone(): boolean {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse && Math.min(window.screen.width, window.screen.height) < 600;
}

/** iPhones count as phones whatever their screen size (a Plus/Max in landscape is wide). */
function isIPhone(): boolean {
  return /iPhone|iPod/.test(navigator.userAgent);
}

/** A phone: gets the gate on / and /studio, and no studio link on /capture. */
export function isPhone(): boolean {
  return looksLikePhone() || isIPhone();
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
  if (skipped || !isPhone()) return start();

  const base = import.meta.env.BASE_URL;
  const gate = document.createElement("main");
  gate.id = "phone-gate";
  gate.innerHTML = `
    <h1>Photo Dojo<span>REVIVAL</span></h1>
    <p><strong>The fight happens on a big screen.</strong> It's a couch game: two players side by side at one laptop or TV, sharing a keyboard or with game controllers. Open this page there.</p>
    <p>Fighters are built in the studio, which runs on a computer too. This phone can be its camera: scan the code the studio shows.</p>
    <a class="button primary" href="${base}capture">Use this phone as the camera</a>
    <button type="button">Show the game anyway</button>
    <p class="muted">Your photos never leave your devices. <a href="${base}about">About, FAQ &amp; credits</a> · <a href="${base}about#feedback">Bugs &amp; ideas</a></p>
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

/** iPads (which may say they're a Mac): allowed in the studio, with a warning that a computer works better. */
export function isTablet(): boolean {
  if (/iPad/.test(navigator.userAgent)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/**
 * The Character Studio needs a computer (the models don't fit in a phone's
 * browser): a phone opening /studio is shown what it can do instead: be
 * the studio's camera.
 */
export function gateStudio(start: () => void): void {
  if (!isPhone()) return start();
  const base = import.meta.env.BASE_URL;
  const gate = document.createElement("main");
  gate.id = "phone-gate";
  gate.innerHTML = `
    <h1>Photo Dojo<span>STUDIO</span></h1>
    <p><strong>The studio runs on a computer.</strong> Open this page on a laptop or desktop to build a fighter.</p>
    <p>This phone can be its camera: scan the code the studio shows, or open the camera page and enter the code.</p>
    <a class="button primary" href="${base}capture">Use this phone as the camera</a>
    <p class="muted">Your photos never leave your devices. <a href="${base}about">About, FAQ &amp; credits</a></p>
  `;
  document.body.prepend(gate);
}
