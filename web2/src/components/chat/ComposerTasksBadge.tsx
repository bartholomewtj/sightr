// Adapted from T3 Code apps/web/src/components/chat/ComposerTasksBadge.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Changes: the shapes and the list derivation live in ComposerStatus.logic (fed by the thread's newest
// `todo_list` item). Phone first: a tap opens the checklist in a bottom sheet (back closes it) instead
// of T3's inline drawer, so a long list never pushes the composer off screen; ComposerTasksDrawer is
// gone. The badge keeps T3's row, count and segment bar; list rows are 44 px on touch.
import { CheckIcon, CircleDotIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { memo } from "react";

import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { useSheetHistory } from "../RightPanelSheet";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerTaskStep, ComposerTasksProgress } from "./ComposerStatus.logic";

export type { ComposerTaskStep, ComposerTasksProgress } from "./ComposerStatus.logic";

const MAX_TASK_SEGMENTS = 10;

const taskStatusLabels = {
  pending: "Pending",
  inProgress: "Running",
  completed: "Completed",
} satisfies Record<ComposerTaskStep["status"], string>;

function keyedTaskSteps(steps: readonly ComposerTaskStep[]) {
  const occurrences = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });
}

function TaskSegments({ className, steps }: { readonly className?: string; readonly steps: readonly ComposerTaskStep[] }) {
  if (steps.length <= 1 || steps.length > MAX_TASK_SEGMENTS) return null;

  return (
    <span aria-hidden className={cn("flex w-10 shrink-0 items-center gap-0.5", className)}>
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <span
          key={key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.status === "completed" ? "bg-success" : step.status === "inProgress" ? "bg-primary" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function TaskSummary({ progress, steps }: { readonly progress: ComposerTasksProgress; readonly steps: readonly ComposerTaskStep[] }) {
  return (
    <>
      <ComposerBanner.Icon>
        <ListTodoIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground/80" data-composer-task-current="true">
          {progress.step}
        </span>
      </ComposerBanner.Content>
      <ComposerBanner.Actions>
        <ComposerBanner.Count
          className={progress.completedSteps >= progress.totalSteps ? "text-success" : undefined}
          data-composer-task-progress="true"
        >
          {progress.completedSteps}/{progress.totalSteps}
        </ComposerBanner.Count>
        <TaskSegments className="w-16 max-sm:hidden" steps={steps} />
      </ComposerBanner.Actions>
    </>
  );
}

export const ComposerTasksBadge = memo(function ComposerTasksBadge({
  expanded,
  onToggle,
  progress,
  steps,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  if (progress.totalSteps <= 0) return null;

  return (
    <ComposerBanner.Root density="comfortable" data-composer-shoulder-tab>
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-label={`Tasks: ${progress.completedSteps} of ${progress.totalSteps} complete. Current task: ${progress.step}`}
        data-composer-tasks-badge="true"
        className="pointer-coarse:min-h-11"
        onClick={onToggle}
      >
        <TaskSummary progress={progress} steps={steps} />
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
});

/** The checklist, as T3's ComposerTasksContent list. */
export const ComposerTasksList = memo(function ComposerTasksList({
  progress,
  steps,
}: {
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  return (
    <ComposerBanner.Children
      render={<ul role="list" />}
      aria-label={`Task list. ${progress.completedSteps} of ${progress.totalSteps} complete.`}
      data-composer-tasks-list="true"
    >
      {keyedTaskSteps(steps).map(({ key, step }) => (
        <ComposerBanner.Row key={key} render={<li />} className="items-start py-1 pe-2" data-step-status={step.status}>
          <ComposerBanner.Icon
            className={cn(
              "h-4 pointer-coarse:h-6",
              step.status === "completed" ? "text-success" : step.status === "inProgress" ? "text-primary" : "text-muted-foreground/40",
            )}
          >
            {step.status === "completed" ? <CheckIcon /> : step.status === "inProgress" ? <CircleDotIcon /> : <CircleIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content
            className={cn(
              "block wrap-anywhere text-sm",
              step.status === "completed"
                ? "text-muted-foreground/55 line-through"
                : step.status === "inProgress"
                  ? "font-medium text-foreground/90"
                  : "text-muted-foreground/70",
            )}
          >
            <span className="sr-only">{taskStatusLabels[step.status]}: </span>
            {step.step}
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <span className="w-12 text-right text-3xs/4 text-muted-foreground/45 tabular-nums" data-composer-task-duration="true">
              {step.durationMs !== undefined ? formatDuration(step.durationMs) : step.status === "inProgress" ? "now" : null}
            </span>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ))}
    </ComposerBanner.Children>
  );
});

/** Phone first: the checklist in a bottom sheet over the thread. */
export function ComposerTasksSheet({
  open,
  onClose,
  progress,
  steps,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly progress: ComposerTasksProgress;
  readonly steps: readonly ComposerTaskStep[];
}) {
  useSheetHistory(open, onClose);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetPopup side="bottom" className="max-h-[80dvh] pb-[env(safe-area-inset-bottom)]" data-composer-tasks-sheet="true">
        <SheetHeader className="pe-14">
          <SheetTitle className="text-base">
            Tasks{" "}
            <span className={cn("font-normal tabular-nums text-muted-foreground", progress.completedSteps >= progress.totalSteps && "text-success")}>
              {progress.completedSteps}/{progress.totalSteps}
            </span>
          </SheetTitle>
        </SheetHeader>
        {/* The rows' icon column is ComposerBanner.Root's variable; the sheet has no Root, so it sets it. */}
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 [--composer-banner-icon-column:--spacing(7)]">
          <ComposerTasksList progress={progress} steps={steps} />
        </div>
      </SheetPopup>
    </Sheet>
  );
}
