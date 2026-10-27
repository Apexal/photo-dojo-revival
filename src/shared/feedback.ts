/**
 * "Report a problem" and "Suggest an idea": links to the GitHub issue forms in
 * .github/ISSUE_TEMPLATE. A bug report is prefilled with what the browser can
 * say about itself (version, page, browser, screen, WebGPU). Nothing is sent
 * from here: the link opens GitHub, and the player sees and submits the issue.
 */

export const REPO_URL = "https://github.com/Apexal/photo-dojo-revival";

export type FeedbackKind = "bug" | "idea";

const TEMPLATES: Record<FeedbackKind, string> = { bug: "bug_report.yml", idea: "feature_request.yml" };

/** The environment block of a bug report. `details`: a last line with anything the page knows (an error, where it was). */
export function diagnostics(details?: string): string {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const lines = [
    `Version: ${__APP_VERSION__}`,
    typeof location === "undefined" ? null : `Page: ${location.pathname}${location.search}`,
    nav ? `Browser: ${nav.userAgent}` : null,
    typeof screen === "undefined" ? null : `Screen: ${screen.width}×${screen.height} @${typeof devicePixelRatio === "number" ? devicePixelRatio : 1}x`,
    nav ? `WebGPU: ${"gpu" in nav ? "available" : "not available"}` : null,
    details ?? null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/** A new-issue link on the repo, using the kind's form (a bug report gets `diagnostics(details)`). */
export function feedbackUrl(kind: FeedbackKind, details?: string): string {
  const params = new URLSearchParams({ template: TEMPLATES[kind] });
  if (kind === "bug") params.set("environment", diagnostics(details));
  return `${REPO_URL}/issues/new?${params}`;
}
