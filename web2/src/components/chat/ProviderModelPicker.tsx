// Same job and name as T3 Code's apps/web/src/components/chat/ProviderModelPicker.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: the model for a new thread. In T3 the provider and model pick
// together in one popup and can change between turns; in Sightr the harness is its own picker and the
// model is a launch argument, so this field says whether the harness can switch it later (T08 flag).
// The list is the launch table's suggestions plus the operator's own (Settings → New threads).
import { changeLabel, modelError, pickersFor } from "@/components/new-thread/NewThread.logic";
import { pickerModels } from "@/components/new-thread/ThreadDefaults.logic";
import { setDraftModel, useDraftThread } from "@/state/draft-thread";
import { addModelPref, useThreadDefaults } from "@/state/thread-defaults";

import { ModelPickerContent } from "./ModelPickerContent";

export function ProviderModelPicker() {
  const harness = useDraftThread((s) => s.draft.harness);
  const model = useDraftThread((s) => s.draft.model);
  const prefs = useThreadDefaults();
  const pickers = pickersFor(harness);
  if (!pickers.models || !harness) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <PickerLabel id="draft-model-label" label="Model" note={changeLabel(pickers.live.model)} />
      <ModelPickerContent
        labelledBy="draft-model-label"
        models={pickerModels(harness, prefs)}
        value={model}
        error={modelError(harness, model)}
        onChange={setDraftModel}
        onSave={(id) => void addModelPref(harness, id)}
      />
    </section>
  );
}

export function PickerLabel({ id, label, note }: { id: string; label: string; note: string }) {
  return (
    <p className="flex items-baseline gap-2 text-xs">
      <span id={id} className="font-medium text-muted-foreground">
        {label}
      </span>
      <span className="text-muted-foreground/80">{note}</span>
    </p>
  );
}
