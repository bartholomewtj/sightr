// The harness tiles (T14): one per descriptor in shared/agents.ts that has a launch spec, then
// "Terminal only". A radio group; nothing is preselected except the harness last used in the project.
// The table does not know what is installed on the host: a missing binary comes back as a failed start.
import { TerminalIcon } from "lucide-react";

import { AgentIcon } from "@/components/AgentIcon";
import { setDraftHarness, useDraftThread } from "@/state/draft-thread";

import { ChoiceGroup } from "./ChoiceGroup";
import type { HarnessTile } from "./NewThread.logic";

export function HarnessPicker({ tiles }: { tiles: readonly HarnessTile[] }) {
  const harness = useDraftThread((s) => s.draft.harness);
  return (
    <section className="flex w-full flex-col gap-1.5" aria-labelledby="draft-harness-label">
      <p id="draft-harness-label" className="text-xs font-medium text-muted-foreground">
        Start
      </p>
      <ChoiceGroup
        variant="tiles"
        labelledBy="draft-harness-label"
        value={harness}
        onPick={setDraftHarness}
        choices={tiles.map((t) => ({
          value: t.id,
          name: t.label,
          label: (
            <>
              {t.plainShell ? (
                <TerminalIcon className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
              ) : (
                <AgentIcon agent={t.id} className="mt-0.5 size-5" />
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-foreground">{t.label}</span>
                {t.note ? <span className="text-xs text-muted-foreground">{t.note}</span> : null}
              </span>
            </>
          ),
        }))}
      />
    </section>
  );
}
