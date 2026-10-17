// Settings → New threads: what a new thread opens with, per device. The pattern of T3 Code's
// ProjectDefaultsSettings (a default model, traits and permission mode) and ProviderModelsSection
// (favourite, hide and add model ids); Sightr's own body, since the options are the launch table's
// (`pickersFor`) and nothing here names a harness. A project's last model and effort win over these
// defaults when that project is opened again. Bypass permissions can never be a default.
import { EyeIcon, EyeOffIcon, StarIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ChoiceGroup } from "@/components/new-thread/ChoiceGroup";
import { changeLabel, harnessTiles, pickersFor } from "@/components/new-thread/NewThread.logic";
import { defaultsFor, modelChoices, pickerModels } from "@/components/new-thread/ThreadDefaults.logic";
import {
  addModelPref,
  removeModelPref,
  setDefaultHarnessPref,
  setHarnessDefaultPref,
  toggleFavouriteModelPref,
  toggleHiddenModelPref,
  useThreadDefaults,
} from "@/state/thread-defaults";
import { SettingsRow } from "./settingsLayout";

const ASK = "";

export function NewThreadSettings() {
  const prefs = useThreadDefaults();
  // Harnesses with something to set: a launch spec and at least one picker.
  const tiles = harnessTiles().filter((t) => {
    const p = pickersFor(t.id);
    return !t.plainShell && (p.models || p.efforts || p.modes);
  });
  const [picked, setPicked] = useState<string | null>(null);
  const startId = prefs.harness;
  const harness = tiles.some((t) => t.id === picked) ? picked : (tiles.find((t) => t.id === startId)?.id ?? tiles[0]?.id ?? null);
  const startTiles = harnessTiles();

  return (
    <>
      <SettingsRow
        title="Start with"
        description="The harness a new thread opens on when its project has no history yet. A project you used before opens on what you used last. This device only."
      >
        <div className="mt-3">
          <ChoiceGroup
            label="Start with"
            value={prefs.harness ?? ASK}
            onPick={(id) => setDefaultHarnessPref(id === ASK ? null : id)}
            choices={[{ value: ASK, label: "Ask each time" }, ...startTiles.map((t) => ({ value: t.id, label: t.label }))]}
          />
        </div>
      </SettingsRow>
      {harness ? (
        <>
          <SettingsRow
            title="Defaults"
            description="The model, effort and permission mode a new thread opens with, for one harness. A project's last model and effort come back instead when you open that project again. This device only."
          >
            <div className="mt-3 flex flex-col gap-4">
              <ChoiceGroup label="Defaults for" value={harness} onPick={setPicked} choices={tiles.map((t) => ({ value: t.id, label: t.label }))} />
              <HarnessDefaults harness={harness} />
            </div>
          </SettingsRow>
          <ModelsRow harness={harness} />
        </>
      ) : null}
    </>
  );
}

function HarnessDefaults({ harness }: { harness: string }) {
  const prefs = useThreadDefaults();
  const pickers = pickersFor(harness);
  const current = defaultsFor(prefs, harness);
  const models = pickerModels(harness, prefs);
  return (
    <div className="flex flex-col gap-4">
      {pickers.models ? (
        <Group label="Model" note={changeLabel(pickers.live.model)}>
          <ChoiceGroup
            label="Default model"
            value={current.model === "" || models.some((m) => m.id === current.model) ? current.model : null}
            onPick={(model) => setHarnessDefaultPref(harness, { model })}
            choices={[{ value: "", label: "Default" }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
          />
        </Group>
      ) : null}
      {pickers.efforts ? (
        <Group label="Effort" note={changeLabel(pickers.live.effort)}>
          <ChoiceGroup
            label="Default effort"
            value={current.effort}
            onPick={(effort) => setHarnessDefaultPref(harness, { effort })}
            choices={[{ value: "", label: "Default" }, ...pickers.efforts.map((e) => ({ value: e, label: e }))]}
          />
        </Group>
      ) : null}
      {pickers.modes ? (
        <Group label="Permission mode" note={changeLabel(pickers.live.mode)}>
          <ChoiceGroup
            label="Default permission mode"
            value={current.permissionMode}
            onPick={(permissionMode) => setHarnessDefaultPref(harness, { permissionMode })}
            choices={[{ value: "", label: "Default" }, ...pickers.modes.filter((m) => !m.destructive).map((m) => ({ value: m.id, label: m.label }))]}
          />
          {pickers.modes.some((m) => m.destructive) ? (
            <p className="text-xs text-muted-foreground/80">A mode that skips approvals is never a default. Choose it on the new-thread screen each time.</p>
          ) : null}
        </Group>
      ) : null}
    </div>
  );
}

function Group({ label, note, children }: { label: string; note: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <p className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/80">{note}</span>
      </p>
      {children}
    </section>
  );
}

function ModelsRow({ harness }: { harness: string }) {
  const prefs = useThreadDefaults();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const choices = modelChoices(harness, prefs);
  if (!pickersFor(harness).models) return null;

  const add = () => {
    const why = addModelPref(harness, draft);
    setError(why);
    if (!why) setDraft("");
  };

  return (
    <SettingsRow
      title="Models"
      description="Star a model to list it first, hide one you never use, or add an id the list lacks. The new-thread picker shows this list, so you never retype an id. This device only."
    >
      <ul aria-label="Models" className="mt-3 divide-y divide-border/50 rounded-lg border border-border/50">
        {choices.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">No models yet. Add one below.</li> : null}
        {choices.map((c) => (
          <li key={c.id} data-hidden={c.hidden || undefined} className="flex items-center gap-1 px-2">
            <span className={`min-w-0 flex-1 truncate py-2 pl-1 text-sm ${c.hidden ? "text-muted-foreground line-through" : ""}`}>
              {c.label}
              {c.label.toLowerCase() !== c.id ? <span className="ml-2 font-mono text-xs text-muted-foreground">{c.id}</span> : null}
            </span>
            {!c.hidden ? (
              <IconToggle
                label={c.favourite ? `Unstar ${c.label}` : `Star ${c.label}`}
                pressed={c.favourite}
                onClick={() => toggleFavouriteModelPref(harness, c.id)}
              >
                <StarIcon className={c.favourite ? "fill-current" : ""} />
              </IconToggle>
            ) : null}
            {c.custom ? (
              <IconToggle label={`Remove ${c.label}`} onClick={() => removeModelPref(harness, c.id)}>
                <XIcon />
              </IconToggle>
            ) : (
              <IconToggle label={c.hidden ? `Show ${c.label}` : `Hide ${c.label}`} onClick={() => toggleHiddenModelPref(harness, c.id)}>
                {c.hidden ? <EyeOffIcon /> : <EyeIcon />}
              </IconToggle>
            )}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            font="mono"
            aria-label="Add a model id"
            placeholder="Add a model id"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            aria-invalid={error ? true : undefined}
          />
          {error ? <p className="text-xs text-warn">{error}</p> : null}
        </div>
        <Button type="submit" variant="outline" className="pointer-coarse:min-h-11">
          Add
        </Button>
      </form>
    </SettingsRow>
  );
}

function IconToggle({ label, pressed, onClick, children }: { label: string; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className="pointer-coarse:size-11"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
