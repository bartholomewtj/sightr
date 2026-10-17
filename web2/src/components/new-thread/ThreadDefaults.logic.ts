// New-thread defaults and the model list the spawn picker shows (Settings → New threads). Pure rules; the
// store is state/thread-defaults.ts. The idea follows T3 Code's ProjectDefaultsSettings (a default model,
// traits and permission mode for new threads) and ProviderModelsSection (favourite, hide and add custom
// model ids) in pattern only: Sightr's pickers are launch arguments, so the options come from the launch
// table through `pickersFor`, never from a harness id.
import { MODEL_PATTERN } from "@shared/agents";

import { isDestructiveMode, modelError, pickersFor, tileFor } from "./NewThread.logic";

/** "" in any field means "not chosen": no argument, the harness's own default. */
export interface HarnessDefaults {
  model: string;
  effort: string;
  permissionMode: string;
}

export interface ModelPrefs {
  /** Model ids the operator added (kept in the order added). */
  custom: string[];
  /** Launch-table suggestions the picker leaves out. */
  hidden: string[];
  /** Shown first, with a star. */
  favourite: string[];
}

export interface ThreadDefaultsPrefs {
  /** The harness a project with no history opens on; null asks each time. */
  harness: string | null;
  perHarness: Record<string, HarnessDefaults>;
  models: Record<string, ModelPrefs>;
}

export const EMPTY_HARNESS_DEFAULTS: HarnessDefaults = { model: "", effort: "", permissionMode: "" };
export const EMPTY_MODEL_PREFS: ModelPrefs = { custom: [], hidden: [], favourite: [] };
export const EMPTY_THREAD_DEFAULTS: ThreadDefaultsPrefs = { harness: null, perHarness: {}, models: {} };

/** A cap so a damaged store cannot grow the picker without end. */
export const MAX_CUSTOM_MODELS = 30;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && MODEL_PATTERN.test(x)))] : [];

/**
 * What a harness may keep as its default. A model must be a valid id; an effort or mode must be in the
 * launch table; a destructive mode (it skips approvals) is never kept: it is chosen fresh, with its two
 * confirmations, every time.
 */
export function cleanDefaults(harness: string | null, d: Partial<HarnessDefaults>): HarnessDefaults {
  const pickers = pickersFor(harness);
  const model = (d.model ?? "").trim();
  const effort = d.effort ?? "";
  const mode = d.permissionMode ?? "";
  return {
    model: pickers.models && model !== "" && modelError(harness, model) === null ? model : "",
    effort: pickers.efforts?.includes(effort) ? effort : "",
    permissionMode: pickers.modes?.some((m) => m.id === mode) && !isDestructiveMode(harness, mode) ? mode : "",
  };
}

/** Read what storage holds. Anything that no longer fits the launch table is dropped, not kept. */
export function sanitizePrefs(raw: unknown): ThreadDefaultsPrefs {
  if (!isObj(raw)) return EMPTY_THREAD_DEFAULTS;
  const wanted = raw.harness;
  const harness = typeof wanted === "string" && tileFor(wanted) ? wanted : null;
  const perHarness: Record<string, HarnessDefaults> = {};
  if (isObj(raw.perHarness)) {
    for (const [id, value] of Object.entries(raw.perHarness)) {
      if (!tileFor(id) || !isObj(value)) continue;
      const clean = cleanDefaults(id, value as Partial<HarnessDefaults>);
      if (clean.model || clean.effort || clean.permissionMode) perHarness[id] = clean;
    }
  }
  const models: Record<string, ModelPrefs> = {};
  if (isObj(raw.models)) {
    for (const [id, value] of Object.entries(raw.models)) {
      if (!tileFor(id) || !isObj(value)) continue;
      const prefs = { custom: strings(value.custom).slice(0, MAX_CUSTOM_MODELS), hidden: strings(value.hidden), favourite: strings(value.favourite) };
      if (prefs.custom.length || prefs.hidden.length || prefs.favourite.length) models[id] = prefs;
    }
  }
  return { harness, perHarness, models };
}

export function defaultsFor(prefs: ThreadDefaultsPrefs, harness: string | null): HarnessDefaults {
  return harness ? cleanDefaults(harness, prefs.perHarness[harness] ?? {}) : EMPTY_HARNESS_DEFAULTS;
}

export function modelPrefsFor(prefs: ThreadDefaultsPrefs, harness: string | null): ModelPrefs {
  return (harness ? prefs.models[harness] : undefined) ?? EMPTY_MODEL_PREFS;
}

export function setDefaultHarness(prefs: ThreadDefaultsPrefs, id: string | null): ThreadDefaultsPrefs {
  return { ...prefs, harness: id && tileFor(id) ? id : null };
}

/** Change one default of a harness. A destructive mode is refused (the old value stays). */
export function setHarnessDefault(
  prefs: ThreadDefaultsPrefs,
  harness: string,
  patch: Partial<HarnessDefaults>,
): ThreadDefaultsPrefs {
  if (!tileFor(harness)) return prefs;
  const merged = cleanDefaults(harness, { ...(prefs.perHarness[harness] ?? EMPTY_HARNESS_DEFAULTS), ...patch });
  const perHarness = { ...prefs.perHarness };
  if (merged.model || merged.effort || merged.permissionMode) perHarness[harness] = merged;
  else delete perHarness[harness];
  return { ...prefs, perHarness };
}

// ── Models ──────────────────────────────────────────────────────────────────────────────────────

export interface ModelChoice {
  id: string;
  label: string;
  favourite: boolean;
  /** Added by the operator (it can be removed); false for a launch-table suggestion. */
  custom: boolean;
  hidden: boolean;
}

/**
 * Every model of a harness the operator can manage: the launch table's suggestions, then their own, with
 * favourites first. `hidden` entries are included (Settings lists them to bring them back); the spawn
 * picker uses {@link pickerModels}.
 */
export function modelChoices(harness: string | null, prefs: ThreadDefaultsPrefs): ModelChoice[] {
  const built = pickersFor(harness).models ?? [];
  const own = modelPrefsFor(prefs, harness);
  const seen = new Set<string>();
  const all: ModelChoice[] = [];
  for (const m of built) {
    seen.add(m.id);
    all.push({ id: m.id, label: m.label, favourite: own.favourite.includes(m.id), custom: false, hidden: own.hidden.includes(m.id) });
  }
  for (const id of own.custom) {
    if (seen.has(id)) continue;
    seen.add(id);
    all.push({ id, label: id, favourite: own.favourite.includes(id), custom: true, hidden: false });
  }
  // Stable: favourites first, otherwise the order above.
  return [...all.filter((c) => c.favourite), ...all.filter((c) => !c.favourite)];
}

/** What the spawn picker lists: everything not hidden. */
export function pickerModels(harness: string | null, prefs: ThreadDefaultsPrefs): ModelChoice[] {
  return modelChoices(harness, prefs).filter((c) => !c.hidden);
}

/** Add a model id to a harness's own list. `error` says why not; an id already listed is only starred. */
export function addCustomModel(
  prefs: ThreadDefaultsPrefs,
  harness: string,
  raw: string,
): { prefs: ThreadDefaultsPrefs } | { error: string } {
  const id = raw.trim();
  if (id === "") return { error: "Type a model id." };
  if (!pickersFor(harness).models) return { error: "This harness takes no model." };
  const bad = modelError(harness, id);
  if (bad) return { error: bad };
  const own = modelPrefsFor(prefs, harness);
  const listed = modelChoices(harness, prefs).some((c) => c.id === id);
  if (listed) {
    return { prefs: withModels(prefs, harness, { ...own, hidden: own.hidden.filter((h) => h !== id) }) };
  }
  if (own.custom.length >= MAX_CUSTOM_MODELS) return { error: `Keep it to ${MAX_CUSTOM_MODELS} models; remove one first.` };
  return { prefs: withModels(prefs, harness, { ...own, custom: [...own.custom, id] }) };
}

export function toggleFavourite(prefs: ThreadDefaultsPrefs, harness: string, id: string): ThreadDefaultsPrefs {
  const own = modelPrefsFor(prefs, harness);
  const favourite = own.favourite.includes(id) ? own.favourite.filter((f) => f !== id) : [...own.favourite, id];
  return withModels(prefs, harness, { ...own, favourite });
}

/** Hide or show a launch-table suggestion. A hidden model cannot also be the default. */
export function toggleHidden(prefs: ThreadDefaultsPrefs, harness: string, id: string): ThreadDefaultsPrefs {
  const own = modelPrefsFor(prefs, harness);
  const hiding = !own.hidden.includes(id);
  const next = withModels(prefs, harness, { ...own, hidden: hiding ? [...own.hidden, id] : own.hidden.filter((h) => h !== id) });
  return hiding && next.perHarness[harness]?.model === id ? setHarnessDefault(next, harness, { model: "" }) : next;
}

export function removeCustomModel(prefs: ThreadDefaultsPrefs, harness: string, id: string): ThreadDefaultsPrefs {
  const own = modelPrefsFor(prefs, harness);
  const next = withModels(prefs, harness, {
    custom: own.custom.filter((c) => c !== id),
    hidden: own.hidden,
    favourite: own.favourite.filter((f) => f !== id),
  });
  return next.perHarness[harness]?.model === id ? setHarnessDefault(next, harness, { model: "" }) : next;
}

function withModels(prefs: ThreadDefaultsPrefs, harness: string, own: ModelPrefs): ThreadDefaultsPrefs {
  const models = { ...prefs.models };
  if (own.custom.length || own.hidden.length || own.favourite.length) models[harness] = own;
  else delete models[harness];
  return { ...prefs, models };
}
