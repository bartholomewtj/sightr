// Same job and name as T3 Code's apps/web/src/components/BranchToolbar.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: the row under a draft's composer that says where the thread will
// run. T3 shows the environment, worktree and branch; Sightr shows the pane placement and the tab name
// (the thread's title until the agent names itself). Herdr owns worktrees, so there is no branch here.
import { Input } from "~/components/ui/input";
import { currentSplitSource, setDraftDirection, setDraftName, setDraftPlacement, useDraftThread } from "@/state/draft-thread";
import { useShell } from "@/stream/stores";

import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";

export function BranchToolbar() {
  const placement = useDraftThread((s) => s.draft.placement);
  const direction = useDraftThread((s) => s.draft.direction);
  const name = useDraftThread((s) => s.draft.name);
  // Re-read when the open thread, the project or the shell change.
  useDraftThread((s) => `${s.openThreadId}:${s.draft.projectId}`);
  useShell((s) => s.threads);
  const split = currentSplitSource();
  return (
    <section aria-label="Where" className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <BranchToolbarEnvModeSelector
        placement={placement}
        splitAvailable={split !== null}
        direction={direction}
        onPlacementChange={setDraftPlacement}
        onDirectionChange={setDraftDirection}
      />
      <Input
        size="sm"
        aria-label="Tab name"
        placeholder="Tab name (default)"
        value={name}
        maxLength={80}
        onChange={(e) => setDraftName(e.target.value)}
        className="sm:max-w-56"
      />
    </section>
  );
}
