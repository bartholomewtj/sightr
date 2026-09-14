import { CircleDot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useWheelPrefs } from "@/hooks/use-wheel-prefs";
import { useOperatorKeys } from "@/lib/operator-commands";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { wheelChoices } from "@/lib/wheel";

export function WheelPrefsControl() {
  // Passing null as the agent means Settings has no pane to scope to, so unscoped rows appear.
  const operatorKeys = useOperatorKeys();
  const presets = ctrlPresetsFor(null, operatorKeys);
  const choices = wheelChoices(presets);
  const { picks, toggle, clear, full } = useWheelPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4">
        <CircleDot className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">Gesture wheel</div>
          <p className="text-sm text-muted-foreground">
            Hold the circle on the reply box to fan these out. A plain tap toggles Keys.
          </p>
        </div>
      </div>

      <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/30 px-3 py-1">
        {choices.map((choice) => {
          const isPicked = picks.includes(choice.id);
          const hint =
            choice.slice.kind === "type"
              ? "Arms typing straight into the terminal"
              : choice.slice.keys.join(" ");
          return (
            <div
              key={choice.id}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <div className="min-w-0">
                <span className="block text-sm font-medium">
                  {choice.slice.label}
                </span>
                {hint && (
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {hint}
                  </p>
                )}
              </div>
              <div className="shrink-0">
                <Switch
                  checked={isPicked}
                  disabled={full && !isPicked}
                  onCheckedChange={() => toggle(choice.id)}
                  aria-label={choice.label}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border/60 bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        {full
          ? "Six slices is the maximum — turn one off to add another."
          : `${picks.length} of 6 chosen. The wheel follows this order, left to right.`}
      </div>

      {picks.length > 0 && (
        <div className="border-t border-border/60 bg-muted/30 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clear}
          >
            Use the default wheel
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            With nothing chosen the wheel falls back to [[wheel]] rows in keys.toml, or the shipped Esc / Tab / Enter / Type.
          </p>
        </div>
      )}
    </Card>
  );
}
