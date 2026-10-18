// T28: expand unchanged lines in the Diff panel, end to end against the fake review API: the whole-file route is
// asked for on the first tap of a control (never on render), once per file, and the states it can answer with.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useRightPanelStore } from "@/rightPanelStore";
import { drawWindows, fake, mountPanel, section, settle, useDiffPanelHarness } from "@/test/diffPanelHarness";
import type { FakeFile } from "@/test/diffServer";

const FILE = "src/big.ts";
const lineOf = (i: number, edit: Record<number, string> = {}) => edit[i] ?? `const v${i} = ${i};`;
const OLD = Array.from({ length: 120 }, (_, i) => lineOf(i + 1));
const NEW = Array.from({ length: 120 }, (_, i) => lineOf(i + 1, { 3: "const v3 = 'three';", 100: "const v100 = 'hundred';" }));
const hunk = (start: number, at: number) => [`@@ -${start},7 +${start},7 @@`, ...[0, 1, 2].map((i) => ` ${OLD[start - 1 + i]}`), `-${OLD[at - 1]}`, `+${NEW[at - 1]}`, ...[1, 2, 3].map((i) => ` ${OLD[at - 1 + i]}`)];
const head = (path: string) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
const PATCH = [...head(FILE), "@@ -1,6 +1,6 @@", ...[0, 1].map((i) => ` ${OLD[i]}`), `-${OLD[2]}`, `+${NEW[2]}`, ...[3, 4, 5].map((i) => ` ${OLD[i]}`), ...hunk(97, 100), ""].join("\n");
const textSide = (lines: string[]) => ({ state: "text" as const, text: lines.join("\n") + "\n", crlf: false });
const big = (over: Partial<FakeFile> = {}): FakeFile => ({ path: FILE, patch: PATCH, contents: { old: textSide(OLD), new: textSide(NEW) }, ...over });

useDiffPanelHarness([big()]);

const controls = (path = FILE) => Array.from(section(path).querySelectorAll<HTMLElement>("[data-diff-expand]")).map((b) => b.textContent);
const control = (label: string, path = FILE) => Array.from(section(path).querySelectorAll<HTMLElement>("[data-diff-expand]")).find((b) => b.textContent === label) as HTMLElement;
const tap = (el: HTMLElement) => act(async () => { fireEvent.click(el); });
const row = (n: number, path = FILE) => section(path).querySelector<HTMLElement>(`[data-new-line="${n}"]`);
const ready = async () => {
  await mountPanel();
  await waitFor(() => expect(section(FILE).querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull()); // the renderer, not the plain lines it shows while it loads
};

describe("DiffPanel: expand unchanged lines", () => {
  it("does not read the file until a control is tapped, then once for any number of taps", async () => {
    await ready();
    await settle();
    expect(controls()).toEqual(["↓ 20 more below the previous hunk", "↑ 20 more above the next hunk", "Show all 90", "↓ 20 more below", "Show all"]);
    expect(fake.contentsCalls).toHaveLength(0);

    await tap(control("↓ 20 more below the previous hunk"));
    await waitFor(() => expect(row(7)).not.toBeNull());
    expect(fake.contentsCalls).toHaveLength(1);
    const call = fake.contentsCalls[0]!;
    expect(call.searchParams.get("file")).toBe(FILE);
    expect(call.searchParams.get("path")).toBe("proj");
    expect(call.searchParams.get("scope")).toBe("working-tree");
    expect(call.searchParams.has("ignoreWhitespace")).toBe(false);

    // 20 lines with real numbers on both sides (the hunks before it change no line count).
    expect([row(7)?.dataset.oldLine, row(7)?.dataset.newLine]).toEqual(["7", "7"]);
    expect(row(26)).not.toBeNull();
    expect(row(27)).toBeNull();
    expect(row(26)?.textContent).toContain("const v26 = 26;");

    await tap(control("↑ 20 more above the next hunk"));
    expect(row(77)).not.toBeNull();
    // The last hunk ends at line 103 of 120: 17 lines remain, one step.
    expect(controls()).toContain("Show 17 lines");
    await tap(control("Show 17 lines"));
    drawWindows();
    await waitFor(() => expect(row(104)).not.toBeNull());
    expect(row(120)?.textContent).toContain("const v120 = 120;");
    expect(fake.contentsCalls).toHaveLength(1);
  });

  it("show all merges the hunks: the control row goes and the lines run on", async () => {
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(row(50)).not.toBeNull());
    expect(section(FILE).querySelector('[data-diff-gap="1"]')).toBeNull();
    drawWindows();
    await waitFor(() => expect(row(96)).not.toBeNull());
  });

  it("asks the file again after a refresh that changed the diff", async () => {
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(row(50)).not.toBeNull());
    expect(fake.contentsCalls).toHaveLength(1);
    act(() => fake.setFiles([big({ version: 1 })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fake.patchCalls.length).toBeGreaterThan(1));
    await waitFor(() => expect(row(50)).toBeNull()); // a new patch starts the gaps again
    await tap(control("Show all 90"));
    await waitFor(() => expect(row(50)).not.toBeNull());
    expect(fake.contentsCalls).toHaveLength(2);
  });

  it("starts the gaps again when Ignore whitespace is flipped", async () => {
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(row(50)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Ignore whitespace" }));
    await waitFor(() => expect(fake.listCalls.at(-1)?.searchParams.get("ignoreWhitespace")).toBe("1"));
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull());
    expect(row(50)).toBeNull();
    expect(controls()).toContain("Show all 90");
  });
});

describe("DiffPanel: expand, states", () => {
  it("has no controls for an added or a deleted file", async () => {
    const added = [...head("src/new.ts"), "new file mode 100644", "@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n").replace("--- a/src/new.ts", "--- /dev/null");
    const deleted = [...head("src/old.ts"), "deleted file mode 100644", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n").replace("+++ b/src/old.ts", "+++ /dev/null");
    fake.setFiles([{ path: "src/new.ts", kind: "added", patch: added }, { path: "src/old.ts", kind: "deleted", patch: deleted }]);
    await mountPanel();
    await waitFor(() => expect(section("src/new.ts").querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull());
    drawWindows();
    await waitFor(() => expect(section("src/old.ts").querySelector("[data-diff-adapter] [data-diff-line]")).not.toBeNull());
    expect(document.querySelector("[data-diff-expand]")).toBeNull();
  });

  it("says 'Binary file' for a binary file, which has no patch and no controls", async () => {
    fake.setFiles([{ path: "img.png", binary: true }]);
    await mountPanel();
    await waitFor(() => expect(section("img.png")).toHaveTextContent("Binary file"));
    expect(document.querySelector("[data-diff-expand]")).toBeNull();
  });

  it("a file over the host's cap: one note, no controls", async () => {
    fake.setFiles([big({ contents: { new: { state: "too-large", bytes: 2_000_000 } } })]);
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-expand-note=blocked]")).toHaveTextContent("File too large to expand."));
    expect(controls()).toEqual([]);
  });

  it("a name the host will not show (404): one note, no controls", async () => {
    fake.setFiles([big({ contentsStatus: 404 })]);
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-expand-note=blocked]")).toHaveTextContent("Files keeps that file hidden"));
    expect(controls()).toEqual([]);
  });

  it("a binary new side reads as binary", async () => {
    fake.setFiles([big({ contents: { new: { state: "binary", bytes: 10 } } })]);
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-expand-note=blocked]")).toHaveTextContent("Binary file"));
  });

  it("a cut patch has no control after its last hunk", async () => {
    fake.setFiles([big({ truncated: true })]);
    await ready();
    expect(controls()).toEqual(["↓ 20 more below the previous hunk", "↑ 20 more above the next hunk", "Show all 90"]);
  });

  it("a file that changed since the diff: says so, shows nothing from it, and hides the controls", async () => {
    fake.setFiles([big({ contents: { old: textSide(OLD), new: textSide(["// a new first line", ...NEW]) } })]);
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-expand-note=stale]")).toHaveTextContent("File changed since this diff. Refresh."));
    expect(controls()).toEqual([]);
    expect(row(50)).toBeNull();
  });

  it("a failed read says 'Couldn't read this file', keeps the diff, and reads again on Retry", async () => {
    fake.setFiles([big({ contentsStatus: 500 })]);
    await ready();
    await tap(control("Show all 90"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read this file"));
    expect(section(FILE).querySelector('[data-diff-line="add"]')).not.toBeNull();
    fake.files[0] = big();
    await tap(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(row(50)).not.toBeNull());
    expect(fake.contentsCalls).toHaveLength(2);
  });
});

describe("DiffPanel: expand in split view", () => {
  it("draws the revealed lines on both sides", async () => {
    useRightPanelStore.getState().setDiffLayout("split");
    const { setViewportWidth } = await import("@/test/media");
    const { resizePanel } = await import("@/test/diffPanelHarness");
    setViewportWidth(1280);
    await ready();
    resizePanel(700);
    await waitFor(() => expect(section(FILE).querySelector("[data-diff-layout=split]")).not.toBeNull());
    await tap(control("Show all 90"));
    await waitFor(() => expect(section(FILE).textContent).toContain("const v50 = 50;"));
    const r = Array.from(section(FILE).querySelectorAll<HTMLElement>("[role=row]")).find((x) => x.textContent?.includes("const v50 = 50;"))!;
    expect(Array.from(r.querySelectorAll("[data-diff-side]")).map((h) => h.textContent?.includes("const v50 = 50;"))).toEqual([true, true]);
  });
});
