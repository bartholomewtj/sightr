import { describe, expect, it, vi } from "vitest";

import { createUpdater, FORCE_RELOAD_MS, FORCED_BUILD_KEY, type UpdateDeps } from "./pwa-update";

// Spec 10: a live rebuild swaps the controlling worker in seconds, and only a wedged precache takes
// the unregister-then-reload road.

class FakeWorker extends EventTarget {
  state: ServiceWorkerState;
  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }
  postMessage = vi.fn();
  become(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

function setup(over: Partial<UpdateDeps> = {}, reg: { installing?: FakeWorker } = {}) {
  const store = new Map<string, string>();
  const timers: Array<() => void> = [];
  const registration = {
    installing: null as FakeWorker | null,
    waiting: null as FakeWorker | null,
    update: vi.fn(async () => {
      registration.installing = reg.installing ?? null;
    }),
  };
  const deps: UpdateDeps = {
    appBuild: "1.0.5+abc.100",
    registration: () => registration as unknown as ServiceWorkerRegistration,
    reload: vi.fn(),
    unregisterAll: vi.fn(async () => {}),
    storage: () => ({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    hadController: true,
    ...over,
  };
  const updater = createUpdater(deps);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { updater, deps, registration, store, timers, flush };
}

describe("onServerBuild", () => {
  it("checks for a new worker at once when the server names another build", async () => {
    const worker = new FakeWorker("installing");
    const { updater, registration, deps, flush } = setup({}, { installing: worker });
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
    worker.become("activated");
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.unregisterAll).not.toHaveBeenCalled(); // the happy path never unregisters
  });

  it("does nothing when the server names this bundle's own build, or unknown, or nothing", async () => {
    const { updater, registration, flush } = setup();
    updater.onServerBuild("1.0.5+abc.100");
    updater.onServerBuild("unknown");
    updater.onServerBuild(null);
    updater.onServerBuild(undefined);
    await flush();
    expect(registration.update).not.toHaveBeenCalled();
  });

  it("checks a given server build only once, however often it repeats", async () => {
    const { updater, registration, flush } = setup({}, { installing: new FakeWorker("installing") });
    updater.onServerBuild("1.0.5+def.200");
    updater.onServerBuild("1.0.5+def.200");
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("waits for registration instead of burning the id", async () => {
    let registered: ServiceWorkerRegistration | undefined;
    const { updater, registration, flush } = setup({ registration: () => registered });
    updater.onServerBuild("1.0.5+def.200");
    registered = registration as unknown as ServiceWorkerRegistration;
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});

describe("wedged precache", () => {
  it("unregisters, then reloads, when no newer worker turns up", async () => {
    const { updater, deps, store, flush } = setup();
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(deps.unregisterAll).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(store.get(FORCED_BUILD_KEY)).toBe("1.0.5+def.200");
    expect(vi.mocked(deps.unregisterAll).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(deps.reload).mock.invocationCallOrder[0]!,
    );
  });

  it("forces at most once per server build in a tab, so a mismatched load cannot loop", async () => {
    const { updater, deps, store, flush } = setup();
    store.set(FORCED_BUILD_KEY, "1.0.5+def.200");
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(deps.unregisterAll).not.toHaveBeenCalled();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("does not force without sessionStorage to guard the loop", async () => {
    const { updater, deps, flush } = setup({
      storage: () => {
        throw new Error("blocked");
      },
    });
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(deps.reload).not.toHaveBeenCalled();
  });

  it("forces after the cap when a found worker never activates", async () => {
    const worker = new FakeWorker("installing");
    const { updater, deps, timers, flush } = setup({}, { installing: worker });
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    expect(timers).toHaveLength(1);
    expect(deps.reload).not.toHaveBeenCalled();
    timers[0]!();
    await flush();
    expect(deps.unregisterAll).toHaveBeenCalledTimes(1);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("the cap is a no-op once the worker activated and reloaded", async () => {
    const worker = new FakeWorker("installing");
    const { updater, deps, timers, flush } = setup({}, { installing: worker });
    updater.onServerBuild("1.0.5+def.200");
    await flush();
    worker.become("activated");
    timers[0]!();
    await flush();
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(deps.unregisterAll).not.toHaveBeenCalled();
    expect(FORCE_RELOAD_MS).toBeGreaterThan(0);
  });
});

describe("onControllerChange", () => {
  it("ignores a first visit's initial claim, then reloads on a real swap", () => {
    const { updater, deps } = setup({ hadController: false });
    updater.onControllerChange();
    expect(deps.reload).not.toHaveBeenCalled();
    updater.onControllerChange();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on a return visit's first change", () => {
    const { updater, deps } = setup({ hadController: true });
    updater.onControllerChange();
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });
});
