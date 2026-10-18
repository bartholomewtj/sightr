// T28: ignore whitespace in the Diff panel. The host's `git diff -w` is the only mechanism: the toggle sends
// `ignoreWhitespace=1` for the list and for opened files' patches, both variants stay cached, a file with
// nothing left under `-w` stays listed, and a gap opened under one variant starts again under the other.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRightPanelStore } from "@/rightPanelStore";
import { fakePatch } from "@/test/diffServer";
import { fake, mountPanel, section, settle, useDiffPanelHarness } from "@/test/diffPanelHarness";

const five = ["a", "b", "c", "d", "e"].map((n) => ({ path: `src/${n}.ts`, patch: fakePatch(`src/${n}.ts`, "old", "new"), wsPatch: fakePatch(`src/${n}.ts`, "old-w", "new-w") }));
useDiffPanelHarness(five);

const toggle = (path: string) => section(path).querySelector<HTMLButtonElement>("h3 button[aria-expanded]") as HTMLButtonElement;
const wsButton = () => screen.getByRole("button", { name: "Ignore whitespace" });
const wsParam = (u: URL) => u.searchParams.get("ignoreWhitespace");
const text = (path: string) => section(path).querySelector("[data-diff-body]")?.textContent ?? "";

describe("DiffPanel: ignore whitespace", () => {
  it("is off by default and sends nothing about whitespace", async () => {
    await mountPanel();
    expect(wsButton()).toHaveAttribute("aria-pressed", "false");
    expect(fake.listCalls.every((u) => wsParam(u) === null)).toBe(true);
  });

  it("refetches the list and the opened files only, with ignoreWhitespace=1", async () => {
    await mountPanel();
    fireEvent.click(toggle("src/a.ts"));
    await waitFor(() => expect(text("src/a.ts")).toContain("new"));
    expect(fake.patchPaths()).toEqual(["src/a.ts"]);
    const listsBefore = fake.listCalls.length;

    fireEvent.click(wsButton());
    expect(wsButton()).toHaveAttribute("aria-pressed", "true");
    expect(useRightPanelStore.getState().diffIgnoreWhitespace).toBe(true);
    await waitFor(() => expect(text("src/a.ts")).toContain("new-w"));
    expect(fake.listCalls).toHaveLength(listsBefore + 1);
    expect(wsParam(fake.listCalls.at(-1)!)).toBe("1");
    expect(fake.patchCalls.map((u) => [u.searchParams.get("file"), wsParam(u)])).toEqual([["src/a.ts", null], ["src/a.ts", "1"]]);

    // A file opened afterwards is fetched with the flag as it stands.
    fireEvent.click(toggle("src/b.ts"));
    await waitFor(() => expect(text("src/b.ts")).toContain("new-w"));
    expect(fake.patchCalls.at(-1) && wsParam(fake.patchCalls.at(-1)!)).toBe("1");
    expect(fake.patchPaths().filter((p) => p === "src/c.ts")).toEqual([]);
  });

  it("keeps both variants: toggling back makes no request and shows the first patch at once", async () => {
    await mountPanel();
    fireEvent.click(toggle("src/a.ts"));
    await waitFor(() => expect(text("src/a.ts")).toContain("new"));
    fireEvent.click(wsButton());
    await waitFor(() => expect(text("src/a.ts")).toContain("new-w"));
    const lists = fake.listCalls.length;
    const patches = fake.patchCalls.length;

    fireEvent.click(wsButton());
    await waitFor(() => expect(text("src/a.ts")).not.toContain("new-w"));
    expect(text("src/a.ts")).toContain("new");
    fireEvent.click(wsButton());
    await waitFor(() => expect(text("src/a.ts")).toContain("new-w"));
    await settle();
    expect(fake.listCalls).toHaveLength(lists);
    expect(fake.patchCalls).toHaveLength(patches);
  });

  it("a refresh in the plain view leaves the other variant behind: switching to it asks again (a 304 when nothing moved), not for its patches", async () => {
    await mountPanel();
    fireEvent.click(toggle("src/a.ts"));
    await waitFor(() => expect(text("src/a.ts")).toContain("new"));
    fireEvent.click(wsButton());
    await waitFor(() => expect(text("src/a.ts")).toContain("new-w"));
    fireEvent.click(wsButton()); // back to plain
    await waitFor(() => expect(text("src/a.ts")).not.toContain("new-w"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await settle();
    const lists = fake.listCalls.length;
    const patches = fake.patchCalls.length;
    fireEvent.click(wsButton()); // to the whitespace variant, which the refresh left behind
    await waitFor(() => expect(fake.listCalls).toHaveLength(lists + 1));
    expect(wsParam(fake.listCalls.at(-1)!)).toBe("1");
    expect(fake.listHeaders.at(-1)?.ifNoneMatch).toBe('"h1-w"');
    await settle();
    expect(fake.patchCalls).toHaveLength(patches);
    expect(text("src/a.ts")).toContain("new-w");
  });

  it("a refresh in the whitespace view reads the plain list too, so switching back costs nothing", async () => {
    await mountPanel();
    fireEvent.click(wsButton());
    await waitFor(() => expect(fake.listCalls.map(wsParam)).toEqual([null, "1"]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.listCalls).toHaveLength(4));
    expect(fake.listCalls.slice(2).map(wsParam).sort()).toEqual(["1", null]);
    fireEvent.click(wsButton());
    await settle();
    expect(fake.listCalls).toHaveLength(4);
  });

  it("starts on when the stored choice is on, with no plain request first", async () => {
    useRightPanelStore.getState().setDiffIgnoreWhitespace(true);
    await mountPanel();
    expect(wsButton()).toHaveAttribute("aria-pressed", "true");
    // The whitespace list leaves out whitespace-only files, which the plain list supplies, so both are read.
    expect(fake.listCalls.map(wsParam).sort()).toEqual(["1", null]);
  });

  it("is switched off, with the reason, in a run's scope", async () => {
    useRightPanelStore.getState().setDiffIgnoreWhitespace(true);
    await mountPanel();
    const { useDiffPanelStore } = await import("@/diffPanelStore");
    act(() => useDiffPanelStore.getState().setScope("t1", { kind: "run", runId: "r1" }));
    const button = await screen.findByRole("button", { name: "Ignore whitespace" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Not available for this run");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });
});

describe("DiffPanel: ignore whitespace, a file with nothing left", () => {
  useDiffPanelHarness([{ path: "src/ws.ts", whitespaceOnly: true }, { path: "src/real.ts" }]);

  it("stays listed (the plain list supplies it), marked 'whitespace only', with no patch asked for and nothing to expand", async () => {
    await mountPanel();
    await waitFor(() => expect(fake.patchPaths().sort()).toEqual(["src/real.ts", "src/ws.ts"]));
    fireEvent.click(wsButton());
    await waitFor(() => expect(within(section("src/ws.ts")).getByText("whitespace only")).toBeInTheDocument());
    expect(document.querySelector("[data-diff-tree-file='src/ws.ts']")).toHaveTextContent("whitespace only");
    await waitFor(() => expect(text("src/ws.ts")).toContain("Whitespace changes only."));
    expect(section("src/ws.ts").querySelector("[data-diff-expand]")).toBeNull();
    // The whitespace-only file's patch is not fetched again under -w; the other file's is.
    await waitFor(() => expect(fake.patchCalls.filter((u) => wsParam(u) === "1").map((u) => u.searchParams.get("file"))).toEqual(["src/real.ts"]));
  });
});
