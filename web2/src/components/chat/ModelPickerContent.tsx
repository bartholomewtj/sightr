// Same job and name as T3 Code's apps/web/src/components/chat/ModelPickerContent.tsx @ e3b35d1b (MIT, see
// THIRD_PARTY.md), Sightr's own body: the list of models for one harness. T3 lists the models a
// provider reports; Sightr lists the launch table's short suggestions (T07) plus free text, since the
// host's CLIs are not asked what they have. "Default" sends no model flag.
import { Input } from "~/components/ui/input";
import type { LaunchChoice } from "@shared/agents";
import { ChoiceGroup } from "@/components/new-thread/ChoiceGroup";

export function ModelPickerContent({
  labelledBy,
  models,
  value,
  error,
  onChange,
}: {
  labelledBy: string;
  models: readonly LaunchChoice[];
  value: string;
  error: string | null;
  onChange(model: string): void;
}) {
  const known = value === "" || models.some((m) => m.id === value);
  return (
    <div className="flex flex-col gap-1.5">
      <ChoiceGroup
        labelledBy={labelledBy}
        value={known ? value : null}
        onPick={onChange}
        choices={[{ value: "", label: "Default" }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
      />
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
      {error ? <p className="text-xs text-warn">{error}</p> : null}
    </div>
  );
}
