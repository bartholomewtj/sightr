// The read-only branch chip (T3's BranchToolbarBranchSelector, without the switching): the branch a
// project's checkout is on, from `Project.branch`. Nothing here changes a branch, and nothing renders when
// the project has none (a detached head, a folder that is not a checkout, a bridge that predates the field).
import { GitBranch } from "lucide-react";

import { cn } from "@/lib/utils";

/** Keep the start and the end of a long branch name ("feat/…/fix-login"), where the part that tells them apart usually is. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max || max < 5) return text;
  const tail = Math.ceil((max - 1) * 0.45);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export const BRANCH_CHIP_MAX_CHARS = 24;

export function BranchChip({ branch, className }: { branch: string | undefined; className?: string }) {
  if (!branch) return null;
  return (
    <span
      data-branch-chip=""
      title={`Branch ${branch}`}
      className={cn("inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-full border border-line/60 px-1.5 font-mono text-3xs leading-4 text-muted-foreground", className)}
    >
      <GitBranch className="size-2.5 shrink-0" aria-hidden />
      <span className="sr-only">Branch </span>
      <span className="truncate">{middleTruncate(branch, BRANCH_CHIP_MAX_CHARS)}</span>
    </span>
  );
}
