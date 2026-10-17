import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { pickersFor } from "@/components/new-thread/NewThread.logic";
import { defaultsFor } from "@/components/new-thread/ThreadDefaults.logic";
import { project, shellSnapshot, thread } from "@/test/fixtures";
import { shellFromSnapshot } from "@/stream/apply";
import { useShell } from "@/stream/stores";
import { server } from "@/test/setup";

import {
  __setDraftDeps,
  EMPTY_DRAFT,
  LAST_KEY,
  pickDraftMode,
  seedPickers,
  selectDraftProject,
  setDraftEffort,
  setDraftHarness,
  setDraftModel,
  startDraft,
  useDraftThread,
} from "./draft-thread";
import {
  __resetThreadDefaults,
  addModelPref,
  getThreadDefaults,
  setDefaultHarnessPref,
  setHarnessDefaultPref,
  THREAD_DEFAULTS_KEY,
  toggleFavouriteModelPref,
} from "./thread-defaults";

const H = "claude";
const models = pickersFor(H).models!;
const model = models[1]!.id;
const effort = pickersFor(H).efforts![0]!;
const safeMode = pickersFor(H).modes!.find((m) => !m.destructive)!.id;
const bypass = pickersFor(H).modes!.find((m) => m.destructive)!.id;
const other = pickersFor("pi").models![0]!.id;
const draft = () => useDraftThread.getState().draft;

let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  __resetThreadDefaults();
  posts = [];
  let n = 0;
  __setDraftDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true, sequence: 11 });
    }),
  );
  useShell.setState(shellFromSnapshot(shellSnapshot(5, [thread("t1")], [project("w1"), project("w2", { number: 2, order: 1 })])), true);
});

describe("the store", () => {
  it("persists, and a reload reads the same prefs back", () => {
    setDefaultHarnessPref(H);
    setHarnessDefaultPref(H, { model, effort });
    expect(addModelPref(H, "my-model")).toBeNull();
    toggleFavouriteModelPref(H, "my-model");
    expect(JSON.parse(localStorage.getItem(THREAD_DEFAULTS_KEY)!).harness).toBe(H);
    __resetThreadDefaults();
    expect(getThreadDefaults().harness).toBe(H);
    expect(defaultsFor(getThreadDefaults(), H)).toEqual({ model, effort, permissionMode: "" });
    expect(getThreadDefaults().models[H]!.favourite).toEqual(["my-model"]);
  });

  it("an id the harness would refuse is not added", () => {
    expect(addModelPref(H, "no spaces")).toMatch(/Letters, digits/);
    expect(getThreadDefaults().models).toEqual({});
  });

  it("never stores bypass permissions, and reads a hand-edited one back as none", () => {
    setHarnessDefaultPref(H, { permissionMode: bypass });
    expect(getThreadDefaults().perHarness[H]).toBeUndefined();
    localStorage.setItem(THREAD_DEFAULTS_KEY, JSON.stringify({ perHarness: { [H]: { permissionMode: bypass, effort } } }));
    __resetThreadDefaults();
    expect(defaultsFor(getThreadDefaults(), H)).toEqual({ model: "", effort, permissionMode: "" });
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(THREAD_DEFAULTS_KEY, "{not json");
    __resetThreadDefaults();
    expect(getThreadDefaults().harness).toBeNull();
  });
});

describe("the new-thread draft", () => {
  it("choosing a harness opens its default model, effort and mode", () => {
    setHarnessDefaultPref(H, { model, effort, permissionMode: safeMode });
    setDraftHarness(H);
    expect(draft()).toMatchObject({ harness: H, model, effort, permissionMode: safeMode });
  });

  it("another harness with no defaults still clears the pickers", () => {
    setHarnessDefaultPref(H, { model, effort });
    setDraftHarness(H);
    setDraftHarness("pi");
    expect(draft()).toMatchObject({ harness: "pi", model: "", effort: "", permissionMode: "" });
  });

  it("a project with no history opens on the default harness; one with history keeps its own", () => {
    setDefaultHarnessPref(H);
    setHarnessDefaultPref(H, { model });
    selectDraftProject("w1");
    expect(draft()).toMatchObject({ projectId: "w1", harness: H, model });
    localStorage.setItem(LAST_KEY, JSON.stringify({ w2: { harness: "pi", permissionMode: "", model: other, effort: "" } }));
    selectDraftProject("w2");
    expect(draft()).toMatchObject({ projectId: "w2", harness: "pi", model: other });
  });

  it("a draft that already picked a harness is left alone when a project is chosen", () => {
    setDefaultHarnessPref(H);
    setDraftHarness("pi");
    selectDraftProject("w1");
    expect(draft().harness).toBe("pi");
  });

  it("no default harness and no history: only the project is chosen", () => {
    selectDraftProject("w1");
    expect(draft()).toEqual({ ...EMPTY_DRAFT, projectId: "w1" });
  });

  it("the project's last model and effort beat the defaults; a stored bypass does not come back", () => {
    setHarnessDefaultPref(H, { model: models[0]!.id, effort: pickersFor(H).efforts![1]! });
    localStorage.setItem(LAST_KEY, JSON.stringify({ w1: { harness: H, permissionMode: bypass, model, effort } }));
    selectDraftProject("w1");
    expect(draft()).toMatchObject({ harness: H, model, effort, permissionMode: "" });
  });

  it("choosing the same harness again in a project brings back its last model", () => {
    localStorage.setItem(LAST_KEY, JSON.stringify({ w1: { harness: H, permissionMode: "", model, effort } }));
    selectDraftProject("w1");
    setDraftHarness("pi");
    setDraftHarness(H);
    expect(draft()).toMatchObject({ harness: H, model, effort });
  });

  it("an old last-used entry (no model or effort) falls back to the defaults", () => {
    setHarnessDefaultPref(H, { model, effort });
    localStorage.setItem(LAST_KEY, JSON.stringify({ w1: { harness: H, permissionMode: safeMode } }));
    expect(seedPickers("w1", H)).toEqual({ model, effort, permissionMode: safeMode });
  });

  it("a last-used choice of 'Default' (empty) is respected over a default", () => {
    setHarnessDefaultPref(H, { model });
    localStorage.setItem(LAST_KEY, JSON.stringify({ w1: { harness: H, permissionMode: "", model: "", effort: "" } }));
    expect(seedPickers("w1", H).model).toBe("");
  });

  it("a last-used model that is no longer valid is dropped", () => {
    localStorage.setItem(LAST_KEY, JSON.stringify({ w1: { harness: H, permissionMode: "", model: "bad id!", effort: "warp" } }));
    expect(seedPickers("w1", H)).toEqual({ model: "", effort: "", permissionMode: "" });
  });

  it("starting remembers the model and effort per project, never a bypass mode", async () => {
    selectDraftProject("w1");
    setDraftHarness(H);
    setDraftModel(model);
    setDraftEffort(effort);
    pickDraftMode(bypass);
    pickDraftMode(bypass);
    expect(await startDraft()).toBe("confirm");
    expect(await startDraft()).toBe("started");
    expect(posts[0]).toMatchObject({ projectId: "w1", harness: H, model, effort, permissionMode: bypass, confirmBypass: true });
    expect(JSON.parse(localStorage.getItem(LAST_KEY)!).w1).toEqual({ harness: H, permissionMode: "", model, effort });
  });
});
