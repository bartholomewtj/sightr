import { afterEach, describe, expect, it, vi } from "vitest";

import { basenameFor, stripBase, withBase } from "./base";

// v1 is served at /v1/ since the T15 cutover; Vitest runs at vite's default base `/`.
describe("v1 base helpers", () => {
  it("maps app paths to and from /v1/", () => {
    expect(basenameFor("/v1/")).toBe("/v1");
    expect(basenameFor("/")).toBe("/");
    expect(withBase("/pane/w1:p1", "/v1/")).toBe("/v1/pane/w1:p1");
    expect(withBase("/", "/v1/")).toBe("/v1/");
    expect(withBase("/sw.js", "/")).toBe("/sw.js");
    expect(stripBase("/v1/pane/p1", "/v1/")).toBe("/pane/p1");
    expect(stripBase("/v1/", "/v1/")).toBe("/");
    expect(stripBase("/v1", "/v1/")).toBe("/");
    expect(stripBase("/thread/t1", "/v1/")).toBeNull();
    expect(stripBase("/v1x", "/v1/")).toBeNull();
    expect(stripBase("/pane/p1", "/")).toBe("/pane/p1");
  });
});

describe("under /v1/", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
  });

  it("a relaunch at /v1/ resumes the last screen under /v1/", async () => {
    vi.stubEnv("BASE_URL", "/v1/");
    vi.resetModules();
    const { rememberPath, restoreOnBoot } = await import("./last-path");
    rememberPath("/pane/w1:p1");
    window.history.replaceState(null, "", "/v1/");
    restoreOnBoot();
    expect(window.location.pathname).toBe("/v1/pane/w1:p1");
  });

  it("a path remembered with the base on it restores once, not doubled", async () => {
    vi.stubEnv("BASE_URL", "/v1/");
    vi.resetModules();
    const { rememberPath, restoreOnBoot } = await import("./last-path");
    rememberPath("/v1/pane/w1:p1");
    window.history.replaceState(null, "", "/v1/");
    restoreOnBoot();
    expect(window.location.pathname).toBe("/v1/pane/w1:p1");
  });

  it("a page outside /v1/ is never rewritten", async () => {
    vi.stubEnv("BASE_URL", "/v1/");
    vi.resetModules();
    const { rememberPath, restoreOnBoot } = await import("./last-path");
    rememberPath("/pane/w1:p1");
    window.history.replaceState(null, "", "/");
    restoreOnBoot();
    expect(window.location.pathname).toBe("/");
  });
});
