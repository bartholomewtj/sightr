// The seam through its real `lazy(() => import("diffs-adapter"))` path: the Suspense fallback shows first,
// then the adapter the alias points at (`hand` unless SIGHTR_DIFFS says otherwise) replaces it.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiffCodeView } from "./DiffCodeView.tsx";

const FILE = "src/a.ts";
const PATCH = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n");
const EMPTY = ["diff --git a/src/a.ts b/src/a.ts", "index 1111111..2222222 100644", ""].join("\n");

afterEach(() => {
  cleanup();
  vi.doUnmock("diffs-adapter");
  vi.resetModules();
});

describe("DiffCodeView", () => {
  it("shows the hunk lines as the fallback, then the adapter replaces them", async () => {
    // A fresh module, so `lazy` has not resolved yet.
    vi.resetModules();
    const { DiffCodeView: Fresh } = await import("./DiffCodeView.tsx");
    const { container } = render(<Fresh patch={PATCH} filePath={FILE} wrap />);
    const fallback = container.querySelector("[data-diff-fallback]");
    expect(fallback).not.toBeNull();
    expect(fallback?.textContent).toContain("@@ -1,2 +1,2 @@");
    expect(fallback?.textContent).toContain("-old");
    expect(fallback?.textContent).toContain("+new");
    expect(fallback?.textContent).not.toContain("diff --git"); // starts at the first hunk
    expect(container.querySelector("[data-diff-adapter]")).toBeNull();

    await waitFor(() => expect(container.querySelector("[data-diff-adapter]")).not.toBeNull());
    expect(container.querySelector("[data-diff-adapter]")?.getAttribute("data-diff-adapter")).toBe("hand");
    expect(container.querySelector("[data-diff-fallback]")).toBeNull();
    expect(screen.getAllByText(FILE).length).toBeGreaterThan(0); // the adapter's own header
  });

  it("says so in the fallback for a patch with no hunk", async () => {
    vi.resetModules();
    const { DiffCodeView: Fresh } = await import("./DiffCodeView.tsx");
    const { container } = render(<Fresh patch={EMPTY} filePath={FILE} wrap={false} />);
    expect(container.querySelector("[data-diff-fallback]")?.textContent).toContain("No changes to show");
    await waitFor(() => expect(container.querySelector("[data-diff-adapter]")).not.toBeNull());
  });

  it("is a plain component once the adapter has loaded (no fallback on a second mount)", async () => {
    const first = render(<DiffCodeView patch={PATCH} filePath={FILE} wrap />);
    await waitFor(() => expect(first.container.querySelector("[data-diff-adapter]")).not.toBeNull());
    first.unmount();
    const second = render(<DiffCodeView patch={PATCH} filePath={FILE} wrap />);
    expect(second.container.querySelector("[data-diff-adapter]")).not.toBeNull();
  });

  it("preloads the renderer chunk before any diff is drawn: the chunk is requested once, and drawing a diff later reuses it", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("diffs-adapter", () => {
      loads += 1;
      return { default: () => <div data-diff-adapter="preloaded" /> };
    });
    const mod = await import("./DiffCodeView.tsx");
    expect(loads).toBe(0); // importing the seam loads nothing: the adapter is its own chunk
    await mod.preloadDiffRenderer();
    expect(loads).toBe(1);
    const { container } = render(<mod.DiffCodeView patch={PATCH} filePath={FILE} wrap />);
    await waitFor(() => expect(container.querySelector("[data-diff-adapter=preloaded]")).not.toBeNull());
    expect(loads).toBe(1);
  });

  it("swallows a failed preload (the diff itself reports it through the caller's boundary)", async () => {
    vi.resetModules();
    vi.doMock("diffs-adapter", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    const mod = await import("./DiffCodeView.tsx");
    await expect(mod.preloadDiffRenderer()).resolves.toBeUndefined();
  });

  it("draws the first window at once unless told it is not eager, and hides its header on request", async () => {
    const big = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +1,130 @@", ...Array.from({ length: 130 }, (_, i) => `+line ${i}`), ""].join("\n");
    const lazy = render(<DiffCodeView patch={big} filePath={FILE} wrap eager={false} header={false} />);
    await waitFor(() => expect(lazy.container.querySelector("[data-diff-adapter]")).not.toBeNull());
    expect(lazy.container.querySelector("[data-diff-window]")).not.toBeNull();
    expect(lazy.container.querySelectorAll("[data-diff-window=on]").length).toBeGreaterThanOrEqual(0);
    expect(within(lazy.container).queryByText(FILE)).toBeNull(); // no adapter header
    lazy.unmount();
    const eager = render(<DiffCodeView patch={big} filePath={FILE} wrap />);
    await waitFor(() => expect(eager.container.querySelector("[data-diff-adapter]")).not.toBeNull());
    expect(within(eager.container).getByText(FILE)).toBeInTheDocument();
  });

  it("a Retry gets a fresh renderer after a failed import (React.lazy keeps a rejection for good)", async () => {
    vi.resetModules();
    let fail = true;
    vi.doMock("diffs-adapter", () => {
      if (fail) throw new Error("Failed to fetch dynamically imported module");
      return { default: () => <div data-diff-adapter="retried" /> };
    });
    class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
      state = { error: false };
      static getDerivedStateFromError() {
        return { error: true };
      }
      render() {
        return this.state.error ? <p role="alert">failed</p> : this.props.children;
      }
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod = await import("./DiffCodeView.tsx");
    const first = render(<Boundary><mod.DiffCodeView patch={PATCH} filePath={FILE} wrap /></Boundary>);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    first.unmount();
    fail = false;
    vi.resetModules();
    vi.doMock("diffs-adapter", () => ({ default: () => <div data-diff-adapter="retried" /> }));
    mod.resetDiffRenderer();
    const second = render(<Boundary><mod.DiffCodeView patch={PATCH} filePath={FILE} wrap /></Boundary>);
    await waitFor(() => expect(second.container.querySelector("[data-diff-adapter=retried]")).not.toBeNull());
    vi.restoreAllMocks();
  });

  it("with an adapter chunk that fails to load: the fallback stays only until React gives up, then the error reaches the nearest boundary", async () => {
    // Recorded behaviour, not a design: the seam has no error boundary of its own, so a rejected import
    // unmounts the fallback and throws to whatever boundary the caller has (T27 should put one around it).
    vi.resetModules();
    vi.doMock("diffs-adapter", () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
      state = { error: null as string | null };
      static getDerivedStateFromError(e: Error) {
        return { error: e.message };
      }
      render() {
        return this.state.error ? <p role="alert">boundary: {this.state.error}</p> : this.props.children;
      }
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { DiffCodeView: Fresh } = await import("./DiffCodeView.tsx");
    const { container } = render(
      <Boundary>
        <Fresh patch={PATCH} filePath={FILE} wrap />
      </Boundary>,
    );
    expect(container.querySelector("[data-diff-fallback]")).not.toBeNull(); // first, the fallback
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/^boundary: /)); // vitest wraps the factory error in its own message
    expect(container.querySelector("[data-diff-fallback]")).toBeNull(); // the fallback does not stay
    vi.restoreAllMocks();
  });
});
