import { foldEntries, foldLabel, thinkingDuration } from "./transcript-fold";
import type { TranscriptEntry, TranscriptPart } from "./types";

const tool = (name: string, summary = "", result?: { text: string; isError?: boolean }): TranscriptPart => ({
  kind: "tool",
  name,
  summary,
  ...(result ? { result } : {}),
});

const at = (
  uuid: string,
  ts: string,
  parts: TranscriptPart[],
  role: TranscriptEntry["role"] = "assistant",
): TranscriptEntry => ({
  uuid,
  ts,
  role,
  parts,
});

describe("foldEntries", () => {
  const day1 = "2026-07-25T10:00:00.000Z";
  const day2 = "2026-07-26T10:00:00.000Z";

  it("six tool-only assistant entries fold to one item", () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      at(`a${i}`, day1, [tool("Bash", `cmd ${i}`)]),
    );
    const items = foldEntries(entries);
    expect(items).toHaveLength(2); // divider + fold
    expect(items[0]!.kind).toBe("divider");
    expect(items[1]!.kind).toBe("fold");
    if (items[1]!.kind === "fold") {
      expect(items[1]!.entries).toHaveLength(6);
      expect(items[1]!.tools).toHaveLength(6);
      expect(items[1]!.key).toBe("fold:a0");
    }
  });

  it("prose in the middle splits into two folds", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("a1", day1, [tool("Bash", "2")]),
      at("a2", day1, [{ kind: "text", text: "found it" }]),
      at("a3", day1, [tool("Bash", "3")]),
      at("a4", day1, [tool("Bash", "4")]),
    ];
    const items = foldEntries(entries);
    // [divider, fold, turn, fold]
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold", "turn", "fold"]);
    if (items[1]!.kind === "fold" && items[3]!.kind === "fold") {
      expect(items[1]!.tools).toHaveLength(2);
      expect(items[3]!.tools).toHaveLength(2);
    }
  });

  it("a user entry splits", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("u0", day1, [{ kind: "text", text: "what next?" }], "user"),
      at("a1", day1, [tool("Bash", "2")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold", "turn", "fold"]);
  });

  it("a day change splits", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("a1", day2, [tool("Bash", "2")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold", "divider", "fold"]);
  });

  it("whitespace text does not split", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("a1", day1, [tool("Bash", "2"), { kind: "text", text: "  \n" }]),
      at("a2", day1, [tool("Bash", "3")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold"]);
    if (items[1]!.kind === "fold") {
      expect(items[1]!.tools).toHaveLength(3);
    }
  });

  it("a thinking part splits, then peels tools off that row into the next fold", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("a1", day1, [tool("Bash", "2"), { kind: "thinking", text: "thinking..." }]),
      at("a2", day1, [tool("Bash", "3")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold", "turn", "fold"]);
    if (items[1]!.kind === "fold" && items[2]!.kind === "turn" && items[3]!.kind === "fold") {
      expect(items[1]!.tools).toHaveLength(1);
      expect(items[2]!.entry.parts).toEqual([{ kind: "thinking", text: "thinking..." }]);
      expect(items[3]!.tools).toHaveLength(2);
    }
  });

  it("peels tools off a mixed prose+tools entry so they fold (Grok shape)", () => {
    const entries = [
      at("a0", day1, [
        { kind: "text", text: "I'll look." },
        tool("read_file", "a.ts"),
        tool("read_file", "b.ts"),
        tool("run_terminal_command", "git status"),
      ]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "turn", "fold"]);
    if (items[1]!.kind === "turn" && items[2]!.kind === "fold") {
      expect(items[1]!.entry.parts).toEqual([{ kind: "text", text: "I'll look." }]);
      expect(items[2]!.tools).toHaveLength(3);
      expect(items[2]!.key).toBe("fold:a0");
    }
  });

  it("merges peeled tools with the following tool-only entry", () => {
    const entries = [
      at("a0", day1, [{ kind: "text", text: "I'll look." }, tool("read_file", "a.ts")]),
      at("a1", day1, [tool("read_file", "b.ts")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "turn", "fold"]);
    if (items[2]!.kind === "fold") {
      expect(items[2]!.tools).toHaveLength(2);
    }
  });

  it("two mixed entries do not merge tools across the second preamble", () => {
    const entries = [
      at("a0", day1, [{ kind: "text", text: "first" }, tool("read_file", "a.ts")]),
      at("a1", day1, [{ kind: "text", text: "second" }, tool("read_file", "b.ts")]),
    ];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "turn", "fold", "turn", "fold"]);
    if (items[2]!.kind === "fold" && items[4]!.kind === "fold") {
      expect(items[2]!.tools).toHaveLength(1);
      expect(items[4]!.tools).toHaveLength(1);
    }
  });

  it("a run of one is still a fold", () => {
    const entries = [at("a0", day1, [tool("Bash", "1")])];
    const items = foldEntries(entries);
    expect(items.map((i) => i.kind)).toEqual(["divider", "fold"]);
    if (items[1]!.kind === "fold") {
      expect(items[1]!.tools).toHaveLength(1);
    }
  });

  it("keys are stable", () => {
    const entries = [
      at("a0", day1, [tool("Bash", "1")]),
      at("a1", day1, [{ kind: "text", text: "hi" }]),
    ];
    const keys1 = foldEntries(entries).map((i) => i.key);
    const keys2 = foldEntries(entries).map((i) => i.key);
    expect(keys1).toEqual(keys2);
  });
});

describe("foldLabel", () => {
  it("counts Bash, Bash, Read into Ran 2 commands, read 1 file", () => {
    expect(foldLabel([{ name: "Bash" }, { name: "Bash" }, { name: "Read" }])).toBe(
      "Ran 2 commands, read 1 file",
    );
  });

  it("formats the full reference table string", () => {
    const tools = [
      ...Array(6).fill({ name: "Bash" }),
      ...Array(3).fill({ name: "Read" }),
      ...Array(2).fill({ name: "Grep" }),
      { name: "Edit" },
    ];
    expect(foldLabel(tools)).toBe(
      "Ran 6 commands, read 3 files, searched 2 files, edited 1 file",
    );
  });

  it("handles unknown tools with lower-case name and singular/plural", () => {
    expect(foldLabel([{ name: "mcp__x" }])).toBe("Made 1 mcp__x call");
    expect(foldLabel([{ name: "mcp__x" }, { name: "mcp__x" }])).toBe("Made 2 mcp__x calls");
  });

  it("handles case-insensitive and alternative names for buckets", () => {
    expect(foldLabel([{ name: "powershell" }])).toBe("Ran 1 command");
    expect(foldLabel([{ name: "Read" }])).toBe("Read 1 file");
    expect(foldLabel([{ name: "Glob" }])).toBe("Searched 1 file");
    expect(foldLabel([{ name: "Write" }])).toBe("Edited 1 file");
  });

  it("maps Grok tool names onto the same buckets as Claude", () => {
    expect(
      foldLabel([
        { name: "run_terminal_command" },
        { name: "run_terminal_command" },
        { name: "read_file" },
        { name: "list_dir" },
        { name: "search_replace" },
      ]),
    ).toBe("Ran 2 commands, read 1 file, searched 1 file, edited 1 file");
  });

  it("returns empty string for empty input", () => {
    expect(foldLabel([])).toBe("");
  });
});

describe("thinkingDuration", () => {
  it("returns seconds between two entries 12 s apart", () => {
    const entries = [
      at("a0", "2026-07-25T10:00:00.000Z", [{ kind: "thinking", text: "pondering" }]),
      at("a1", "2026-07-25T10:00:12.000Z", [{ kind: "text", text: "done" }]),
    ];
    expect(thinkingDuration(entries, 0)).toBe(12);
  });

  it("returns null for the last entry", () => {
    const entries = [
      at("a0", "2026-07-25T10:00:00.000Z", [{ kind: "thinking", text: "pondering" }]),
    ];
    expect(thinkingDuration(entries, 0)).toBeNull();
  });

  it("returns null when a timestamp is empty or invalid", () => {
    const entries1 = [
      at("a0", "", [{ kind: "thinking", text: "pondering" }]),
      at("a1", "2026-07-25T10:00:12.000Z", [{ kind: "text", text: "done" }]),
    ];
    expect(thinkingDuration(entries1, 0)).toBeNull();

    const entries2 = [
      at("a0", "2026-07-25T10:00:00.000Z", [{ kind: "thinking", text: "pondering" }]),
      at("a1", "invalid-time", [{ kind: "text", text: "done" }]),
    ];
    expect(thinkingDuration(entries2, 0)).toBeNull();
  });

  it("returns null for negative difference", () => {
    const entries = [
      at("a0", "2026-07-25T10:00:12.000Z", [{ kind: "thinking", text: "pondering" }]),
      at("a1", "2026-07-25T10:00:00.000Z", [{ kind: "text", text: "done" }]),
    ];
    expect(thinkingDuration(entries, 0)).toBeNull();
  });
});
