// Same job and name as T3 Code's apps/web/src/components/BranchToolbarEnvModeSelector.tsx @ e3b35d1b (MIT,
// see THIRD_PARTY.md), Sightr's own body. T3 picks where a new thread runs (this checkout or a new
// worktree); Sightr picks where the new pane goes: a new tab in the project's workspace, or a split of
// the pane that is open, when that pane is in the same project (T07 `placement`).
import { ChoiceGroup } from "@/components/new-thread/ChoiceGroup";

export function BranchToolbarEnvModeSelector({
  placement,
  splitAvailable,
  direction,
  onPlacementChange,
  onDirectionChange,
}: {
  placement: "tab" | "split";
  splitAvailable: boolean;
  direction: "right" | "down";
  onPlacementChange(placement: "tab" | "split"): void;
  onDirectionChange(direction: "right" | "down"): void;
}) {
  const effective = splitAvailable ? placement : "tab";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ChoiceGroup
        label="Placement"
        value={effective}
        onPick={(v) => onPlacementChange(v === "split" ? "split" : "tab")}
        choices={[
          { value: "tab", label: "New tab" },
          { value: "split", label: "Split current pane", disabled: !splitAvailable },
        ]}
      />
      {effective === "split" ? (
        <ChoiceGroup
          label="Split direction"
          value={direction}
          onPick={(v) => onDirectionChange(v === "down" ? "down" : "right")}
          choices={[
            { value: "right", label: "Right" },
            { value: "down", label: "Down" },
          ]}
        />
      ) : null}
    </div>
  );
}
