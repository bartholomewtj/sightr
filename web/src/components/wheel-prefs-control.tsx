import { CircleDot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useWheelPrefs } from "@/hooks/use-wheel-prefs";
import { useOperatorKeys, useOperatorWheel } from "@/lib/operator-commands";
import { ctrlPresetsFor } from "@/lib/operator-keys";
import { MAX_SLICES, sliceId, wheelChoices, wheelSlicesFor } from "@/lib/wheel";

// The switches show the wheel you actually get. With nothing chosen that is the default wheel
// (keys.toml [[wheel]] rows, else Esc / Tab / Enter / Type), so those rows read ON; flipping any
// switch then starts a custom wheel FROM the defaults instead of replacing all four with one key.
export function WheelPrefsControl() {
  // Passing null as the agent means Settings has no pane to scope to, so unscoped rows appear.
  const operatorKeys = useOperatorKeys();
  const presets = ctrlPresetsFor(null, operatorKeys);
  const choices = wheelChoices(presets);
  const { picks, toggle, replace, clear } = useWheelPrefs();
  const known = new Set(choices.map((c) => c.id));
  const defaults = wheelSlicesFor(useOperatorWheel(), [], presets)
    .map(sliceId)
    .filter((id) => known.has(id));
  const custom = picks.length > 0;
  const shown = custom ? picks : defaults;
  const full = shown.length >= MAX_SLICES;

  function flip(id: string) {
    if (custom) {
      toggle(id);
      return;
    }
    replace(shown.includes(id) ? shown.filter((p) => p !== id) : [...shown, id]);
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4">
        <CircleDot className="size-5 shrink-0 text-muted-foreground" />
        <div>
          <div className="font-medium">Gesture wheel</div>
          <p className="text-sm text-muted-foreground">
            Hold the circle beside Send to fan these out. A plain tap toggles Keys.
          </p>
        </div>
      </div>

      <div className="divide-y divide-border/60 border-t border-border/60 bg-muted/30 px-3 py-1">
        {choices.map((choice) => {
          const isPicked = shown.includes(choice.id);
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
                  onCheckedChange={() => flip(choice.id)}
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
          : custom
            ? `${picks.length} of 6 chosen. The wheel shows them in this list's order.`
            : "This is the default wheel. Flip any switch to make your own, up to six."}
      </div>

      {custom && (
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
