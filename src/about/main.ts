import { feedbackUrl, type FeedbackKind } from "../shared/feedback";

// The static links work without this; it adds the browser's details to a problem report.
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-feedback]")) {
  link.href = feedbackUrl(link.dataset.feedback as FeedbackKind);
  link.target = "_blank";
  link.rel = "noopener";
}
