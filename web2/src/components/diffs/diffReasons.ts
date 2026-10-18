// Sightr code (T27). What the Diff panel says when T26's review routes answer `available: false`.
import type { ReviewUnavailable } from "@shared/v2/review";

export const REVIEW_UNAVAILABLE: Record<ReviewUnavailable, string> = {
  "outside-root": "This folder is outside the Files root.",
  "not-a-repo": "This folder is not a git repository.",
  "git-unavailable": "git isn't installed on the host.",
  timeout: "git took too long. Try Refresh.",
  "no-commits": "No commits yet: there is nothing to compare with.",
  "no-base": "This branch has nothing to compare with (no upstream, main or master).",
  "bad-base": "That base branch isn't in this repository any more.",
  "bad-commit": "That commit isn't in this repository any more.",
  "bad-file": "The host would not read that file.",
  busy: "The host is busy with other diffs. Try again in a moment.",
  // T30's run scope (shared/v2/review.ts); T31 words them for the panel.
  expired: "This run's snapshot is no longer available.",
  "no-checkpoint": "This run has no snapshot to compare.",
};

/** A reason as words; an unknown one (a newer bridge) still says something. */
export function reviewReason(reason: string): string {
  return (REVIEW_UNAVAILABLE as Record<string, string>)[reason] ?? `The host could not read this diff (${reason}).`;
}
