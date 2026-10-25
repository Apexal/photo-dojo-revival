import type { PhoneLinkStatus } from "./phone-session";

/**
 * The phone camera page's screens. Plain DOM, kept apart from the studio's UI
 * and from anything heavy.
 */

type Child = Node | string | null | undefined | false;
type Props = Partial<Record<string, unknown>> & { class?: string; on?: Partial<Record<string, (ev: Event) => void>> };

/** Tiny hyperscript helper, as in the studio: h("button", { class: "primary", on: { click } }, "Go"). */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "on" && value) {
      for (const [ev, fn] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(ev, fn);
    } else if (key === "class") el.className = String(value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
      else el.setAttribute(key, String(value));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const title = () => h("h1", {}, "Photo Dojo", h("span", { class: "kicker" }, "Camera"));

/** What the live screen shows about the link (headline + detail). */
export function describeLink(status: PhoneLinkStatus, roomCode: string): { headline: string; detail: string } {
  switch (status.kind) {
    case "connecting":
      return {
        headline: "Connecting to the studio…",
        detail: status.reason ? `Waiting for studio ${roomCode}. Is the studio open and showing this code?` : `Studio ${roomCode}`,
      };
    case "streaming":
      return { headline: "Streaming to the studio", detail: `Studio ${roomCode}. Keep this page open; the studio takes the photos.` };
    case "reconnecting":
      return { headline: "Reconnecting to the studio…", detail: `Studio ${roomCode}. This page keeps trying; no need to scan again.` };
    case "closed":
      return { headline: "The studio closed", detail: status.reason };
    case "stopped":
      return { headline: "Stopped", detail: "" };
  }
}

export class PhoneView {
  private headline: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private studioStatus: HTMLElement | null = null;

  /** `studioUrl`: shown on code entry when this isn't a phone (a computer opened /capture, and wants the studio). */
  constructor(private readonly root: HTMLElement, private readonly studioUrl: string | null = null) {}

  private show(...children: Child[]): void {
    this.headline = this.detail = this.studioStatus = null;
    this.root.replaceChildren(h("section", { class: "screen" }, ...children));
  }

  codeEntry(onCode: (input: string) => void, error?: string): void {
    const input = h("input", {
      type: "text", placeholder: "ABC234", maxLength: 6, autocapitalize: "characters", autocomplete: "off",
      "aria-label": "Studio code",
    });
    const form = h("form", { class: "code-entry", on: { submit: (ev) => { ev.preventDefault(); onCode(input.value); } } },
      h("label", { for: "studio-code" }, "Enter the code the studio shows"),
      input,
      h("button", { type: "submit", class: "primary" }, "Connect"),
    );
    input.id = "studio-code";
    this.show(
      title(),
      h("p", {}, "This phone becomes the studio's camera: the computer running Photo Dojo shows a QR code and a code. Scan the QR, or type the code here."),
      form,
      error ? h("p", { class: "error" }, error) : null,
      h("p", { class: "muted" }, "The picture goes straight to the studio, peer to peer. Nothing is stored on a server."),
      this.studioUrl ? h("p", { class: "studio-link" }, "On a computer? ", h("a", { href: this.studioUrl }, "Open the studio"), " to build a fighter with this computer's camera or a phone.") : null,
    );
    input.focus();
  }

  starting(): void {
    this.show(title(), h("p", { class: "headline" }, "Opening the camera…"), h("p", { class: "muted" }, "Allow camera access when asked."));
  }

  cameraError(message: string, retry: () => void): void {
    this.show(
      title(),
      h("p", { class: "headline" }, "Couldn't open the camera"),
      h("p", { class: "error" }, message),
      h("p", { class: "muted" }, "Check that this site may use the camera (browser settings), and that no other app is using it."),
      h("button", { type: "button", class: "primary", on: { click: retry } }, "Try again"),
    );
  }

  /** The streaming screen: link state, the studio's status line, a small preview. */
  live(video: HTMLVideoElement): void {
    this.headline = h("p", { class: "headline" });
    this.detail = h("p", { class: "muted" });
    this.studioStatus = h("p", { class: "studio-status" });
    video.classList.add("preview");
    this.root.replaceChildren(h("section", { class: "screen live" },
      title(),
      this.headline,
      this.studioStatus,
      h("div", { class: "preview-box" }, video),
      this.detail,
      h("p", { class: "muted" }, "Stand the phone up with the camera facing the room, far enough back to see you head to toe."),
    ));
  }

  setLink(status: PhoneLinkStatus, roomCode: string): void {
    if (!this.headline || !this.detail) return;
    const { headline, detail } = describeLink(status, roomCode);
    this.headline.textContent = headline;
    this.headline.dataset.state = status.kind;
    this.detail.textContent = detail;
  }

  setStudioStatus(text: string): void {
    if (this.studioStatus) this.studioStatus.textContent = text;
  }

  setMirrored(mirrored: boolean): void {
    this.root.querySelector("video.preview")?.classList.toggle("mirrored", mirrored);
  }

  closed(reason: string, again: () => void): void {
    this.show(
      title(),
      h("p", { class: "headline" }, "The studio closed"),
      reason ? h("p", { class: "muted" }, reason) : null,
      h("button", { type: "button", class: "primary", on: { click: again } }, "Connect again"),
    );
  }
}
