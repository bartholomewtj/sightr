// T27: one Back closes exactly one layer. Before, every `useSheetHistory` instance answered every `popstate`,
// so a picker over the panel (or a changed-file sheet over the thread) closed together with what was under it.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPanelLeaveGuard } from "./right-panel/leaveGuard";
import { openSheetEntries, useSheetHistory } from "./sheetHistory";

// No fixed sleeps: jsdom takes a history step in two nested `setTimeout(0)`s, so how long a Back takes depends on the
// load the machine is under. A Back is waited for by its `popstate`; a chain of them (an orphan's entry is skipped with
// one more step) by what the test then expects, through `waitFor`.
const popped = () => new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
const back = async () => {
  const stepped = popped();
  await act(async () => { window.history.back(); });
  await stepped; // the browser's step, and the sheet history's answer to it (it listens first)
  await act(async () => {}); // what the answer set in React
};
const sheetFlag = () => (window.history.state as Record<string, unknown> | null)?.sightrSheet === true;
const here = () => (window.history.state as Record<string, unknown> | null)?.page;
const thread = () => `thread-${pageId}`;
/**
 * Let a state change flush (effects included). `steps`: the change makes the sheet history take its own entry off, so
 * the browser's step is waited for (a sheet closed under another leaves its entry, and takes no step).
 */
const flush = async (fn: () => void, steps: boolean) => {
  const stepped = steps ? popped() : Promise.resolve();
  await act(async () => { fn(); });
  await stepped;
  await act(async () => {});
};
/** Steps still on their way (one a test started and did not wait for, an orphan's skip) must not land in the next test. */
const drain = async () => {
  let seen = 0;
  const count = () => { seen += 1; };
  window.addEventListener("popstate", count);
  try {
    for (let quiet = 0; quiet < 2; ) {
      const before = seen;
      for (let i = 0; i < 4; i++) await new Promise<void>((r) => setTimeout(r, 0));
      quiet = seen === before ? quiet + 1 : 0;
    }
  } finally {
    window.removeEventListener("popstate", count);
  }
};

let setA: (open: boolean) => void = () => {};
let setB: (open: boolean) => void = () => {};
let setC: (open: boolean) => void = () => {};
let closed: string[] = [];

/** Three independent sheets, as the thread can have: the Diff panel (A), a picker over it (B), another sheet (C). */
function Harness({ initial }: { initial: { a: boolean; b: boolean; c: boolean } }) {
  const [a, sa] = useState(initial.a);
  const [b, sb] = useState(initial.b);
  const [c, sc] = useState(initial.c);
  setA = sa;
  setB = sb;
  setC = sc;
  useSheetHistory(a, () => { closed.push("A"); sa(false); });
  useSheetHistory(b, () => { closed.push("B"); sb(false); });
  useSheetHistory(c, () => { closed.push("C"); sc(false); });
  return <p>{[a && "A", b && "B", c && "C"].filter(Boolean).join("") || "none"}</p>;
}

let pageId = 0;
beforeEach(() => {
  closed = [];
  // The thread page the sheets sit over (each test gets its own, since jsdom keeps one history for the file).
  pageId += 1;
  window.history.pushState({ page: `thread-${pageId}` }, "");
});
afterEach(async () => {
  cleanup();
  await drain();
});

describe("useSheetHistory with sheets stacked", () => {
  it("Back closes the sheet opened last and leaves the one under it; the next Back closes that one; the third leaves the page", async () => {
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true));
    act(() => setB(true));
    expect(container.textContent).toBe("AB");
    expect(openSheetEntries()).toBe(2);

    await back();
    expect(closed).toEqual(["B"]);
    expect(container.textContent).toBe("A");

    await back();
    expect(closed).toEqual(["B", "A"]);
    expect(container.textContent).toBe("none");
    expect(here()).toBe(thread());
    expect(openSheetEntries()).toBe(0);

    // With nothing open, Back is the page's own: no sheet answers it.
    await back();
    expect(closed).toEqual(["B", "A"]);
    expect(here()).not.toBe(thread());
  });

  it("answers in the order the sheets opened, whichever way round they were declared", async () => {
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setC(true));
    act(() => setA(true));
    act(() => setB(true));
    await back();
    await back();
    expect(closed).toEqual(["B", "A"]);
    expect(container.textContent).toBe("C");
    await back();
    expect(closed).toEqual(["B", "A", "C"]);
    expect(here()).toBe(thread());
  });

  it("closing the top sheet by hand takes its own entry off, so one Back still closes the one under it, not the page", async () => {
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true));
    act(() => setB(true));
    await flush(() => setB(false), true); // a pick in the picker, or its X button
    expect(container.textContent).toBe("A");
    expect(openSheetEntries()).toBe(1);
    expect(sheetFlag()).toBe(true);
    expect(closed).toEqual([]); // by hand, so the Back handler did not run
    await back();
    expect(closed).toEqual(["A"]);
    expect(here()).toBe(thread());
  });

  it("closing a sheet under an open one leaves its entry for a Back that skips it, so no Back is wasted", async () => {
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true));
    act(() => setB(true));
    await flush(() => setA(false), false); // the lower sheet goes first (a tab switch, a route change)
    expect(container.textContent).toBe("B");
    await back(); // closes B ...
    expect(closed).toEqual(["B"]);
    expect(container.textContent).toBe("none");
    // ... and the entry A left behind is skipped by the next Back, which leaves the page in one press.
    await back();
    await waitFor(() => expect(here()).not.toBe(thread())); // one Back plus the skip over the entry A left behind
    expect(sheetFlag()).toBe(false);
    expect(openSheetEntries()).toBe(0);
  });

  it("unmounting every open sheet at once leaves entries that one Back skips, to leave the page", async () => {
    const { unmount } = render(<Harness initial={{ a: true, b: true, c: true }} />);
    expect(openSheetEntries()).toBe(3);
    await flush(unmount, true);
    // The top sheet's entry went; the two under it stay as skippable entries, so one Back leaves the page.
    expect(openSheetEntries()).toBe(2);
    await back();
    await waitFor(() => expect(here()).not.toBe(thread()));
    expect(openSheetEntries()).toBe(0);
  });

  // The router's own pushState, as `thread.next` does it: a new entry above whatever is there.
  const route = (name: string) => act(async () => { window.history.pushState({ page: `${thread()}-${name}` }, ""); });

  it("a sheet closed by a route change leaves its entry alone: Back over the router's entries is the router's (X to Y to Z)", async () => {
    render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true)); // thread details open on X
    expect(openSheetEntries()).toBe(1);
    await route("Y");
    await flush(() => setA(false), false); // the route change unmounted the sheet: its entry is under Y now
    expect(openSheetEntries()).toBe(1); // kept, as an orphan
    await route("Z");

    await back(); // Z to Y: not the sheet's pop, and not skipped
    expect(here()).toBe(`${thread()}-Y`);
    expect(openSheetEntries()).toBe(1);
    await back(); // Y to X (the sheet's entry, which shows X)
    expect(here()).toBe(thread());
    expect(closed).toEqual([]);
    await back(); // off the orphan's entry: skipped, so this one Back is enough to leave X
    await waitFor(() => expect(here()).not.toBe(thread()));
    expect(String(here())).not.toContain("-Y");
    expect(openSheetEntries()).toBe(0);
  });

  it("a sheet opened after a route change closes with one Back and leaves the new page", async () => {
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true));
    await route("Y");
    await flush(() => setA(false), false);
    act(() => setB(true)); // a sheet on Y
    expect(openSheetEntries()).toBe(2);
    await back();
    expect(closed).toEqual(["B"]);
    expect(container.textContent).toBe("none");
    expect(here()).toBe(`${thread()}-Y`);
    await back(); // the router's: Y to X's sheet entry
    expect(here()).toBe(thread());
    expect(closed).toEqual(["B"]);
  });

  it("opens with the page already showing a sheet entry, and closes each in turn", async () => {
    const { container } = render(<Harness initial={{ a: true, b: false, c: false }} />);
    act(() => setC(true));
    expect(container.textContent).toBe("AC");
    await back();
    expect(container.textContent).toBe("A");
    await back();
    expect(container.textContent).toBe("none");
    expect(here()).toBe(thread());
  });
});

describe("useSheetHistory with the Files editor's guard", () => {
  afterEach(() => setPanelLeaveGuard(null));

  it("when the guard holds the close, the sheet stays and its entry is back, so the next Back is still its own", async () => {
    let held: (() => void) | null = null;
    const { container } = render(<Harness initial={{ a: false, b: false, c: false }} />);
    act(() => setA(true));
    act(() => setB(true));
    setPanelLeaveGuard((go) => {
      held = go;
      return true;
    });
    await back();
    expect(container.textContent).toBe("AB"); // held
    expect(closed).toEqual([]);
    expect(sheetFlag()).toBe(true);
    expect(openSheetEntries()).toBe(2);

    // Stay: the guard goes away, the next Back closes B as before.
    setPanelLeaveGuard(null);
    await back();
    expect(closed).toEqual(["B"]);
    expect(container.textContent).toBe("A");

    // Discard: the held close runs later and takes the entry off.
    setPanelLeaveGuard((go) => {
      held = go;
      return true;
    });
    await back();
    expect(container.textContent).toBe("A");
    const stepped = popped();
    await act(async () => {
      (held as (() => void) | null)?.();
    });
    await stepped; // the sheet closes, takes its entry off, and the browser steps
    await act(async () => {});
    expect(closed).toEqual(["B", "A"]);
    expect(container.textContent).toBe("none");
    expect(here()).toBe(thread());
  });
});
