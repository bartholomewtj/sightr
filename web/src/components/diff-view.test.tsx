import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView, parseDiff } from "./diff-view";

const two = ["diff --git a/app.py b/app.py", "index e83edb5..fecda85 100644", "--- a/app.py", "+++ b/app.py", "@@ -1,2 +1,2 @@ def f():", " kept", "-old", "+new", "diff --git a/static/index.html b/static/index.html", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/static/index.html", "@@ -0,0 +1,2 @@", "+<p>", "+</p>", ""].join("\n");

describe("parseDiff", () => {
  it("splits per file and counts added and removed lines", () => {
    const files = parseDiff(two);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([["app.py", 1, 1], ["static/index.html", 2, 0]]);
  });
  it("drops index, ---, +++ and mode lines but keeps hunk headers and context", () => {
    expect(parseDiff(two)[0].lines).toEqual(["@@ -1,2 +1,2 @@ def f():", " kept", "-old", "+new"]);
    expect(parseDiff(two)[1].lines).toEqual(["new file mode 100644", "@@ -0,0 +1,2 @@", "+<p>", "+</p>"]);
  });
  it("accepts a bare hunk with no file header", () => { expect(parseDiff("@@ -1 +1 @@\n-old\n+new\n")).toEqual([{ path: "", added: 1, removed: 1, lines: ["@@ -1 +1 @@", "-old", "+new"] }]); });
});

describe("DiffView", () => {
  it("names each file with its counts and colours the changed lines", () => {
    render(<DiffView diff={two} />);
    expect(screen.getByText("app.py")).toBeInTheDocument(); expect(screen.getByText("static/index.html")).toBeInTheDocument();
    expect(screen.getAllByText("+1")).toHaveLength(1); expect(screen.getByText("−1")).toBeInTheDocument(); expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("+new").style.color).toContain("--status-done"); expect(screen.getByText("-old").style.color).toContain("--destructive"); expect(screen.getByText("kept").style.color).toBe("");
    expect(document.body.textContent).not.toContain("index e83edb5");
  });
  it("does not wrap long lines", () => { render(<DiffView diff={two} />); expect(screen.getByText("+new").closest("pre")?.className).toContain("overflow-x-auto"); expect(screen.getByText("+new").closest("pre")?.className).not.toContain("whitespace-pre-wrap"); });
});
