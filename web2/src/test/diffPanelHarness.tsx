// Shared setup for the Diff panel's T28 tests (split, whitespace, expand): the panel against the fake review
// API (`diffServer.ts`), observers the tests can move, and the helpers they all use. The panel's own suite
// (components/DiffPanel.test.tsx) keeps its own copy of this setup.
import { act, render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, expect } from "vitest";

import { DiffPanel } from "@/components/DiffPanel";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { createDiffServer, type DiffServer, type FakeFile } from "@/test/diffServer";
import { thread } from "@/test/fixtures";
import { server } from "@/test/setup";
import { resetOrdinals } from "@/test/turn-items";

type IoEntry = { target: Element; isIntersecting: boolean };
let ios: Array<{ cb: (entries: IoEntry[]) => void; observed: Set<Element> }> = [];
let ros: Array<{ cb: (entries: Array<{ contentRect: { width: number } }>) => void }> = [];

function installObservers() {
  ios = [];
  ros = [];
  class FakeIO {
    private rec: (typeof ios)[number];
    constructor(cb: (entries: IoEntry[]) => void) {
      this.rec = { cb, observed: new Set() };
      ios.push(this.rec);
    }
    observe(el: Element) { this.rec.observed.add(el); }
    unobserve(el: Element) { this.rec.observed.delete(el); }
    disconnect() { this.rec.observed.clear(); }
    takeRecords() { return []; }
  }
  class FakeRO {
    constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) { ros.push({ cb }); }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = FakeIO;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = FakeRO;
}

/** Tell every width observer (the panel's and the diff column's) the new width. */
export function resizePanel(width: number) {
  act(() => {
    for (const r of ros) r.cb([{ contentRect: { width } }]);
  });
}

/** Every window the renderer is holding back mounts, as if scrolled to. */
export function drawWindows() {
  act(() => {
    for (const io of ios) {
      const els = [...io.observed].filter((el) => el.hasAttribute("data-diff-window"));
      if (els.length > 0) io.cb(els.map((target) => ({ target, isIntersecting: true })));
    }
  });
}

export const sections = () => [...document.querySelectorAll<HTMLElement>("[data-diff-file]")];
export const section = (path: string) => sections().find((s) => s.dataset.diffFile === path) as HTMLElement;
export const settle = (ms = 40) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

export const scrolled: string[] = [];
export let fake: DiffServer;

/** Register the per-test setup. `files` are the fake review API's files. Call once at the top of a test file. */
export function useDiffPanelHarness(files: FakeFile[] = [{ path: "src/a.ts" }, { path: "src/b.ts" }]) {
  beforeEach(() => {
    resetOrdinals();
    installObservers();
    fake = createDiffServer(files.map((f) => ({ ...f })));
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push((this as HTMLElement).dataset.diffFile ?? "?");
    };
    server.use(
      http.get("/api/files/pane-folder", () => HttpResponse.json({ path: "proj" })),
      http.get("/api/files/git", () => HttpResponse.json({ available: true, repo: "proj", rel: "", clean: false, entries: [], hidden: 0, statusTruncated: false, diff: "", diffTruncated: false, panes: [], rootPath: "proj" })),
      ...fake.handlers,
    );
    act(() =>
      useThreadStore.setState({
        current: threadFromSnapshot({ sequence: 1, thread: thread("t1", { paneId: "p-t1" }), runs: [], items: [], requests: [], queue: [], historyCursor: null }, false),
        missing: null,
      }),
    );
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
    delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
  });
}

export async function mountPanel(threadId = "t1") {
  const view = render(<DiffPanel threadId={threadId} />);
  await waitFor(() => expect(sections().length + (document.querySelector("[data-diff-message]") ? 1 : 0)).toBeGreaterThan(0));
  return view;
}
