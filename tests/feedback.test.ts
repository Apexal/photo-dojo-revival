import { describe, expect, it } from "vitest";
import { REPO_URL, feedbackUrl } from "../src/shared/feedback";

describe("feedbackUrl", () => {
  it("opens the bug form with the version and the error filled in", () => {
    const url = new URL(feedbackUrl("bug", "Error: Model failed to load"));
    expect(`${url.origin}${url.pathname}`).toBe(`${REPO_URL}/issues/new`);
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    const env = url.searchParams.get("environment")!;
    expect(env).toContain(`Version: ${__APP_VERSION__}`);
    expect(env).toContain("Error: Model failed to load");
  });

  it("opens the idea form without any diagnostics", () => {
    const url = new URL(feedbackUrl("idea"));
    expect(url.searchParams.get("template")).toBe("feature_request.yml");
    expect(url.searchParams.has("environment")).toBe(false);
  });
});
