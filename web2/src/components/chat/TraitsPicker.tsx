// Same job and name as T3 Code's apps/web/src/components/chat/TraitsPicker.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: effort and permission mode for a new thread, from the launch table
// (T07). T3 puts these in a menu beside the model; here they are two radio rows, each saying whether the
// harness can change it after start (T08). A destructive mode (it skips approvals) shows a warning on
// the first tap and is selected only by a second tap; Start then asks once more (README: bypass is
// offered on the phone too, behind two confirmations).
import { TriangleAlertIcon } from "lucide-react";

import { ChoiceGroup } from "@/components/new-thread/ChoiceGroup";
import { changeLabel, pickersFor } from "@/components/new-thread/NewThread.logic";
import { pickDraftMode, setDraftEffort, useDraftThread } from "@/state/draft-thread";

import { PickerLabel } from "./ProviderModelPicker";

export function TraitsPicker() {
  const harness = useDraftThread((s) => s.draft.harness);
  const effort = useDraftThread((s) => s.draft.effort);
  const mode = useDraftThread((s) => s.draft.permissionMode);
  const armed = useDraftThread((s) => s.bypassArmed);
  const pickers = pickersFor(harness);
  const armedMode = armed ? pickers.modes?.find((m) => m.id === armed) : undefined;
  const chosen = pickers.modes?.find((m) => m.id === mode);

  return (
    <>
      {pickers.efforts ? (
        <section className="flex flex-col gap-1.5">
          <PickerLabel id="draft-effort-label" label="Effort" note={changeLabel(pickers.live.effort)} />
          <ChoiceGroup
            labelledBy="draft-effort-label"
            value={effort}
            onPick={setDraftEffort}
            choices={[{ value: "", label: "Default" }, ...pickers.efforts.map((e) => ({ value: e, label: e }))]}
          />
        </section>
      ) : null}
      {pickers.modes ? (
        <section className="flex flex-col gap-1.5">
          <PickerLabel id="draft-mode-label" label="Permission mode" note={changeLabel(pickers.live.mode)} />
          <ChoiceGroup
            labelledBy="draft-mode-label"
            value={mode}
            onPick={(id) => void pickDraftMode(id)}
            choices={[
              { value: "", label: "Default" },
              ...pickers.modes.map((m) => ({ value: m.id, label: m.label, ...(m.destructive ? { tone: "warn" as const } : {}) })),
            ]}
          />
          {armedMode ? (
            <p role="alert" className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {armedMode.label} lets the agent run every tool without asking. Tap it again to use it.
            </p>
          ) : chosen?.destructive ? (
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {chosen.label}: the agent will not ask before running tools.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
