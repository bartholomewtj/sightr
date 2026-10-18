// The error boundary the seam lacks (T25 recorded that a rejected adapter import goes to the nearest caller
// boundary): around `DiffCodeView` in the panel, falling back to the plain lines, with a Retry.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiffFileSection, PatchBody } from "./DiffFileSection";
import { resetDiffRenderer } from "./DiffCodeView";
import type { DiffFileEntry } from "./diffTypes";

let broken = true;
vi.mock("./DiffCodeView", async (importOriginal) => {
  const original = await importOriginal<typeof import("./DiffCodeView")>();
  return {
    ...original,
    resetDiffRenderer: vi.fn(),
    DiffCodeView: (props: { patch: string; filePath: string }) => {
      if (broken) throw new Error("Failed to fetch dynamically imported module");
      return <div data-diff-adapter="stub">{props.filePath}</div>;
    },
  };
});

const PATCH = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new", ""].join("\n");

beforeEach(() => {
  broken = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PatchBody", () => {
  it("falls back to the plain lines when the renderer cannot load, and says so", () => {
    const { container } = render(<PatchBody patch={PATCH} path="a.ts" wrap eager />);
    const failed = container.querySelector("[data-diff-viewer-failed]") as HTMLElement;
    expect(failed).toHaveTextContent("The diff viewer didn't load, so this is plain text.");
    expect(failed.querySelector("[data-diff-fallback]")).toHaveTextContent("-old");
    expect(failed.querySelector("[data-diff-fallback]")).toHaveTextContent("+new");
    expect(container.querySelector("[data-diff-adapter]")).toBeNull();
  });

  it("Retry asks the seam for a fresh renderer and draws the diff once it loads", () => {
    const { container } = render(<PatchBody patch={PATCH} path="a.ts" wrap eager />);
    broken = false;
    fireEvent.click(within(container).getByRole("button", { name: "Retry" }));
    expect(resetDiffRenderer).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-diff-adapter=stub]")).toHaveTextContent("a.ts");
    expect(container.querySelector("[data-diff-viewer-failed]")).toBeNull();
  });

  it("a failure in one file leaves the next file's section alone", () => {
    const file = (path: string): DiffFileEntry => ({ path, kind: "modified", added: 1, removed: 1, countsKnown: true, rev: path });
    const props = { unfolded: true, wrap: true, eager: true, highlighted: false, canOpen: true, onToggle: () => {}, onRetry: () => {}, onOpenInFiles: () => {} };
    const { container } = render(
      <>
        <DiffFileSection file={file("a.ts")} state={{ state: "ready", patch: PATCH }} {...props} />
        <DiffFileSection file={file("b.ts")} state={{ state: "binary" }} {...props} />
      </>,
    );
    expect(container.querySelector("[data-diff-viewer-failed]")).not.toBeNull();
    expect(screen.getByText("Binary file: there is no patch to show.")).toBeInTheDocument();
  });
});
