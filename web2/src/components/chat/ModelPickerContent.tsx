// Same job and name as T3 Code's apps/web/src/components/chat/ModelPickerContent.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: the list of models for one harness. T3 lists the models a
// provider reports; Sightr lists the launch table's short suggestions (T07) and the operator's own
// (Settings → New threads: starred first, hidden ones left out), since the host's CLIs are not asked
// what they have. "Default" sends no model flag. "Other…" opens a free-text id; a valid id that is not
// in the list can be saved to it, so it is never typed twice.
import { StarIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ChoiceGroup } from "@/components/new-thread/ChoiceGroup";

export interface PickerModel {
  id: string;
  label: string;
  favourite?: boolean;
}

const OTHER = "\u0000other";

export function ModelPickerContent({
  labelledBy,
  models,
  value,
  error,
  onChange,
  onSave,
}: {
  labelledBy: string;
  models: readonly PickerModel[];
  value: string;
  error: string | null;
  onChange(model: string): void;
  /** Keep the typed id in the list; absent when the harness's list cannot be edited. */
  onSave?(model: string): void;
}) {
  const known = value === "" || models.some((m) => m.id === value);
  const [otherOpen, setOtherOpen] = useState(false);
  const showOther = otherOpen || !known;
  const typed = value.trim();
  const canSave = onSave !== undefined && !known && typed !== "" && !error;
  return (
    <div className="flex flex-col gap-1.5">
      <ChoiceGroup
        labelledBy={labelledBy}
        value={showOther ? OTHER : value}
        onPick={(pick) => {
          if (pick === OTHER) {
            setOtherOpen(true);
            return;
          }
          setOtherOpen(false);
          onChange(pick);
        }}
        choices={[
          { value: "", label: "Default" },
          ...models.map((m) => ({
            value: m.id,
            name: m.label,
            label: (
              <span className="inline-flex items-center gap-1">
                {m.favourite ? <StarIcon className="size-3 fill-current" aria-hidden /> : null}
                {m.label}
              </span>
            ),
          })),
          { value: OTHER, label: "Other…" },
        ]}
      />
      {showOther ? (
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            font="mono"
            aria-label="Other model id"
            placeholder="Other model id"
            value={known ? "" : value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            className="max-w-72"
          />
          {canSave ? (
            <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => {
                setOtherOpen(false);
                onSave(typed);
              }}>
              Save to my models
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-xs text-warn">{error}</p> : null}
    </div>
  );
}
