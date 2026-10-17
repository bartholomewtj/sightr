import { describe, expect, it } from "vitest";

import { pickersFor } from "./NewThread.logic";
import {
  addCustomModel,
  cleanDefaults,
  defaultsFor,
  EMPTY_THREAD_DEFAULTS,
  MAX_CUSTOM_MODELS,
  modelChoices,
  pickerModels,
  removeCustomModel,
  sanitizePrefs,
  setDefaultHarness,
  setHarnessDefault,
  toggleFavourite,
  toggleHidden,
  type ThreadDefaultsPrefs,
} from "./ThreadDefaults.logic";

const H = "claude";
const modelId = pickersFor(H).models![0]!.id;
const effort = pickersFor(H).efforts![0]!;
const safeMode = pickersFor(H).modes!.find((m) => !m.destructive)!.id;
const bypass = pickersFor(H).modes!.find((m) => m.destructive)!.id;

describe("cleanDefaults", () => {
  it("keeps values the launch table offers", () => {
    expect(cleanDefaults(H, { model: modelId, effort, permissionMode: safeMode })).toEqual({ model: modelId, effort, permissionMode: safeMode });
  });

  it("never keeps a destructive mode", () => {
    expect(cleanDefaults(H, { permissionMode: bypass }).permissionMode).toBe("");
  });

  it("drops an effort or mode the harness does not have, and a malformed model", () => {
    expect(cleanDefaults(H, { effort: "ludicrous", permissionMode: "nope", model: "has space" })).toEqual({ model: "", effort: "", permissionMode: "" });
  });

  it("keeps a free-text model that passes the id rule", () => {
    expect(cleanDefaults(H, { model: "claude-opus-9" }).model).toBe("claude-opus-9");
  });

  it("is empty for the plain shell and an unknown harness", () => {
    expect(cleanDefaults("shell", { model: "x", effort: "high" })).toEqual({ model: "", effort: "", permissionMode: "" });
    expect(cleanDefaults(null, { model: "x" }).model).toBe("");
  });
});

describe("sanitizePrefs", () => {
  it("returns empty prefs for junk", () => {
    expect(sanitizePrefs(null)).toBe(EMPTY_THREAD_DEFAULTS);
    expect(sanitizePrefs("x")).toBe(EMPTY_THREAD_DEFAULTS);
    expect(sanitizePrefs([])).toBe(EMPTY_THREAD_DEFAULTS);
  });

  it("drops unknown harnesses, a stored bypass, bad ids and duplicates", () => {
    const prefs = sanitizePrefs({
      harness: "not-a-harness",
      perHarness: { [H]: { model: modelId, permissionMode: bypass }, ghost: { model: modelId } },
      models: { [H]: { custom: ["good-1", "good-1", "bad id", 5], hidden: [modelId], favourite: ["good-1"] }, ghost: { custom: ["x1"] } },
    });
    expect(prefs.harness).toBeNull();
    expect(prefs.perHarness).toEqual({ [H]: { model: modelId, effort: "", permissionMode: "" } });
    expect(prefs.models).toEqual({ [H]: { custom: ["good-1"], hidden: [modelId], favourite: ["good-1"] } });
  });

  it("keeps a known default harness", () => {
    expect(sanitizePrefs({ harness: H }).harness).toBe(H);
    expect(sanitizePrefs({ harness: "shell" }).harness).toBe("shell");
  });
});

describe("setting defaults", () => {
  it("sets and clears one harness's defaults, merging fields", () => {
    let prefs = setHarnessDefault(EMPTY_THREAD_DEFAULTS, H, { model: modelId });
    prefs = setHarnessDefault(prefs, H, { effort });
    expect(defaultsFor(prefs, H)).toEqual({ model: modelId, effort, permissionMode: "" });
    prefs = setHarnessDefault(setHarnessDefault(prefs, H, { model: "" }), H, { effort: "" });
    expect(prefs.perHarness).toEqual({});
  });

  it("refuses a bypass mode: the stored value is unchanged", () => {
    const withMode = setHarnessDefault(EMPTY_THREAD_DEFAULTS, H, { permissionMode: safeMode });
    expect(setHarnessDefault(withMode, H, { permissionMode: bypass }).perHarness[H]?.permissionMode ?? "").toBe("");
    expect(setHarnessDefault(EMPTY_THREAD_DEFAULTS, H, { permissionMode: bypass })).toEqual(EMPTY_THREAD_DEFAULTS);
  });

  it("the default harness must be a known one, or null", () => {
    expect(setDefaultHarness(EMPTY_THREAD_DEFAULTS, H).harness).toBe(H);
    expect(setDefaultHarness({ ...EMPTY_THREAD_DEFAULTS, harness: H }, null).harness).toBeNull();
    expect(setDefaultHarness(EMPTY_THREAD_DEFAULTS, "ghost").harness).toBeNull();
  });
});

describe("models", () => {
  const added = (prefs: ThreadDefaultsPrefs, id: string) => {
    const res = addCustomModel(prefs, H, id);
    if ("error" in res) throw new Error(res.error);
    return res.prefs;
  };

  it("lists the launch table's suggestions, then the operator's, favourites first", () => {
    let prefs = added(EMPTY_THREAD_DEFAULTS, "my-model");
    expect(modelChoices(H, prefs).map((c) => c.id).slice(-1)).toEqual(["my-model"]);
    prefs = toggleFavourite(prefs, H, "my-model");
    expect(modelChoices(H, prefs)[0]).toMatchObject({ id: "my-model", favourite: true, custom: true });
  });

  it("hides a suggestion from the picker but keeps it in the manage list", () => {
    const prefs = toggleHidden(EMPTY_THREAD_DEFAULTS, H, modelId);
    expect(modelChoices(H, prefs).find((c) => c.id === modelId)?.hidden).toBe(true);
    expect(pickerModels(H, prefs).some((c) => c.id === modelId)).toBe(false);
    expect(pickerModels(H, toggleHidden(prefs, H, modelId)).some((c) => c.id === modelId)).toBe(true);
  });

  it("hiding the default model clears that default", () => {
    const prefs = toggleHidden(setHarnessDefault(EMPTY_THREAD_DEFAULTS, H, { model: modelId }), H, modelId);
    expect(defaultsFor(prefs, H).model).toBe("");
  });

  it("removing a custom model also clears its star and a default that used it", () => {
    let prefs = added(EMPTY_THREAD_DEFAULTS, "my-model");
    prefs = toggleFavourite(setHarnessDefault(prefs, H, { model: "my-model" }), H, "my-model");
    prefs = removeCustomModel(prefs, H, "my-model");
    expect(prefs.models).toEqual({});
    expect(prefs.perHarness).toEqual({});
  });

  it("refuses a bad id, an empty one and a harness with no model flag; a listed id only comes back", () => {
    expect(addCustomModel(EMPTY_THREAD_DEFAULTS, H, "  ")).toEqual({ error: "Type a model id." });
    expect(addCustomModel(EMPTY_THREAD_DEFAULTS, H, "no spaces")).toHaveProperty("error");
    expect(addCustomModel(EMPTY_THREAD_DEFAULTS, "shell", "ok-model")).toHaveProperty("error");
    const hidden = toggleHidden(EMPTY_THREAD_DEFAULTS, H, modelId);
    const back = addCustomModel(hidden, H, modelId);
    expect("prefs" in back && back.prefs.models).toEqual({});
  });

  it("caps the custom list", () => {
    let prefs = EMPTY_THREAD_DEFAULTS;
    for (let i = 0; i < MAX_CUSTOM_MODELS; i++) prefs = added(prefs, `m-${i}`);
    expect(addCustomModel(prefs, H, "one-more")).toHaveProperty("error");
  });
});
