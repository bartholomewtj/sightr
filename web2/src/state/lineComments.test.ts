// T29: the pending line comments. Persisted like drafts, capped, re-anchored when a diff loads, cleared only by a
// confirmed send of their exact block.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { quoteFor } from "@/components/diffs/lineSelection";
import { parsePatch } from "@/components/diffs/parsePatch";
import { formatReviewBlock } from "@/lib/reviewCommentContext";
import {
  __resetLineComments,
  addLineComment,
  clearLineComments,
  commentView,
  consumeSent,
  editLineComment,
  getLineComments,
  markMissingFiles,
  MAX_PENDING_COMMENTS,
  pruneLineComments,
  reanchorFile,
  removeLineComment,
  restoreLineComment,
  type LineComment,
} from "./lineComments";

const KEY = (t: string) => "sightr:v2:line-comments:" + t;
const patch = (hunks: string[]) => ["diff --git a/f.ts b/f.ts", "--- a/f.ts", "+++ b/f.ts", ...hunks].join("\n") + "\n";
const file = (hunks: string[]) => parsePatch(patch(hunks))[0]!;
const BASE = file(["@@ -1,4 +1,5 @@", " one", " two", "-three", "+THREE", "+THREE-B", " four"]);
const SHIFTED = file(["@@ -1,6 +1,7 @@", " zero", " zero-b", " one", " two", "-three", "+THREE", "+THREE-B", " four"]);
const GONE = file(["@@ -1,1 +1,1 @@", "-a", "+b"]);

const input = (over: Partial<Parameters<typeof addLineComment>[1]> = {}) => ({
  path: "f.ts",
  side: "new" as const,
  start: 3,
  end: 4,
  quote: quoteFor(BASE, { side: "new", start: 3, end: 4 })!,
  note: "rename these",
  ...over,
});
const add = (over = {}, t = "t1") => {
  const r = addLineComment(t, input(over));
  if (!r.ok) throw new Error(r.reason);
  return r.comment;
};

beforeEach(() => {
  localStorage.clear();
  __resetLineComments();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saving", () => {
  it("keeps the comment in the list and persists it, quote cut for display and hash over the full lines", () => {
    const long = "+" + "x".repeat(300);
    const c = add({ quote: [long], start: 1, end: 1 });
    expect(c).toMatchObject({ path: "f.ts", side: "new", start: 1, end: 1, note: "rename these", state: "pending" });
    expect(c.quote[0]).toHaveLength(161);
    expect(c.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(getLineComments("t1")).toEqual([c]);
    __resetLineComments(); // a reload: read back from storage
    expect(getLineComments("t1")).toEqual([c]);
  });

  it("refuses an empty note, a note over 1,000 characters, and a range over 12 lines", () => {
    expect(addLineComment("t1", input({ note: "  " }))).toEqual({ ok: false, reason: "empty" });
    expect(addLineComment("t1", input({ note: "n".repeat(1001) }))).toEqual({ ok: false, reason: "note-too-long" });
    expect(addLineComment("t1", input({ quote: Array.from({ length: 13 }, () => " x") }))).toEqual({ ok: false, reason: "range" });
    expect(addLineComment("t1", input({ note: "n".repeat(1000) })).ok).toBe(true);
    expect(getLineComments("t1")).toHaveLength(1);
  });

  it("caps the list at 30", () => {
    for (let i = 0; i < MAX_PENDING_COMMENTS; i++) add({ note: "n" + i });
    expect(addLineComment("t1", input())).toEqual({ ok: false, reason: "full" });
    expect(getLineComments("t1")).toHaveLength(30);
  });

  it("keeps each thread's comments apart", () => {
    add({}, "t1");
    add({ note: "other" }, "t2");
    expect(getLineComments("t1").map((c) => c.note)).toEqual(["rename these"]);
    expect(getLineComments("t2").map((c) => c.note)).toEqual(["other"]);
  });

  it("never touches the draft", () => {
    localStorage.setItem("sightr:v2:draft:t1", JSON.stringify({ text: "mine", at: Date.now() }));
    add();
    expect(JSON.parse(localStorage.getItem("sightr:v2:draft:t1")!).text).toBe("mine");
  });

  it("edits a note, and a range afresh", () => {
    const c = add();
    const r = editLineComment("t1", c.id, { note: "better" });
    expect(r.ok && r.comment).toMatchObject({ note: "better", start: 3, end: 4, hash: c.hash });
    const moved = editLineComment("t1", c.id, { note: "better", range: { start: 1, end: 2, quote: [" one", " two"] } });
    expect(moved.ok && moved.comment).toMatchObject({ start: 1, end: 2 });
    expect(getLineComments("t1")[0]!.hash).not.toBe(c.hash);
  });
});

describe("storage", () => {
  it("works with storage that throws (memory only)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => add()).not.toThrow();
    expect(getLineComments("t1")).toHaveLength(1);
  });

  it("works with no localStorage at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => add()).not.toThrow();
    expect(getLineComments("t1")).toHaveLength(1);
  });

  it("prunes entries older than 48 hours on first use, and unreadable ones", () => {
    const now = Date.now();
    const entry = (at: number) =>
      JSON.stringify({ at, comments: [{ id: "x", path: "f.ts", side: "new", start: 1, end: 1, hash: "00000000", quote: [" a"], note: "n", createdAt: at, state: "pending" }] });
    localStorage.setItem(KEY("old"), entry(now - 49 * 3600_000));
    localStorage.setItem(KEY("fresh"), entry(now - 47 * 3600_000));
    localStorage.setItem(KEY("junk"), "{nope");
    localStorage.setItem("sightr:v2:draft:old", "keep");
    expect(getLineComments("fresh")).toHaveLength(1); // the first access prunes
    expect(localStorage.getItem(KEY("old"))).toBeNull();
    expect(localStorage.getItem(KEY("junk"))).toBeNull();
    expect(localStorage.getItem(KEY("fresh"))).not.toBeNull();
    expect(localStorage.getItem("sightr:v2:draft:old")).toBe("keep");
    pruneLineComments(now + 100 * 3600_000);
    expect(localStorage.getItem(KEY("fresh"))).toBeNull();
  });

  it("drops an expired thread's entry when it is read", () => {
    localStorage.setItem(KEY("t9"), JSON.stringify({ at: Date.now() - 60 * 3600_000, comments: [] }));
    __resetLineComments();
    expect(getLineComments("t9")).toEqual([]);
  });
});

describe("removing", () => {
  it("removes one, and puts it back where it was", () => {
    const [a, b, c] = [add({ note: "a" }), add({ note: "b" }), add({ note: "c" })];
    const removed = removeLineComment("t1", b!.id)!;
    expect(getLineComments("t1").map((x) => x.note)).toEqual(["a", "c"]);
    restoreLineComment("t1", removed.comment, removed.index);
    expect(getLineComments("t1").map((x) => x.id)).toEqual([a!.id, b!.id, c!.id]);
    restoreLineComment("t1", removed.comment, removed.index); // a second Undo adds nothing
    expect(getLineComments("t1")).toHaveLength(3);
  });

  it("clears the thread and its storage key", () => {
    add();
    clearLineComments("t1");
    expect(getLineComments("t1")).toEqual([]);
    expect(localStorage.getItem(KEY("t1"))).toBeNull();
  });
});

describe("re-anchoring when a diff loads", () => {
  it("keeps an anchored comment as it is", () => {
    const c = add();
    const before = getLineComments("t1");
    reanchorFile("t1", "f.ts", BASE);
    expect(getLineComments("t1")).toBe(before); // nothing written
    expect(getLineComments("t1")[0]).toEqual(c);
  });

  it("moves a comment whose lines are found at another place on the same side", () => {
    add();
    reanchorFile("t1", "f.ts", SHIFTED);
    expect(getLineComments("t1")[0]).toMatchObject({ start: 5, end: 6, state: "moved" });
    reanchorFile("t1", "f.ts", SHIFTED); // again: still where it was, still marked moved
    expect(getLineComments("t1")[0]).toMatchObject({ start: 5, end: 6, state: "moved" });
  });

  it("marks a comment outdated when its lines changed, and keeps it with its quote", () => {
    const c = add();
    reanchorFile("t1", "f.ts", file(["@@ -1,4 +1,5 @@", " one", " two", "-three", "+CHANGED", "+THREE-B", " four"]));
    expect(getLineComments("t1")[0]).toMatchObject({ state: "outdated", quote: c.quote, note: c.note, start: 3, end: 4 });
  });

  it("brings an outdated comment back when the lines return", () => {
    add();
    reanchorFile("t1", "f.ts", GONE);
    expect(getLineComments("t1")[0]!.state).toBe("outdated");
    reanchorFile("t1", "f.ts", BASE);
    expect(getLineComments("t1")[0]!.state).toBe("pending");
  });

  it("leaves other files' comments alone", () => {
    add({ path: "g.ts" });
    reanchorFile("t1", "f.ts", GONE);
    expect(getLineComments("t1")[0]!.state).toBe("pending");
  });

  it("a file missing from the scope is outdated, never dropped, and comes back with its diff", () => {
    add();
    add({ path: "g.ts" });
    markMissingFiles("t1", new Set(["g.ts"]));
    expect(getLineComments("t1").map((c) => [c.path, c.state])).toEqual([
      ["f.ts", "outdated"],
      ["g.ts", "pending"],
    ]);
    // The scope is not part of the anchor: when the file's diff matches again, it shows again.
    reanchorFile("t1", "f.ts", BASE);
    expect(getLineComments("t1")[0]!.state).toBe("pending");
  });
});

describe("consumeSent", () => {
  const sent = (...cs: LineComment[]) => cs.map((c) => formatReviewBlock({ ...c, outdated: c.state === "outdated" })).join("\n\n");

  it("deletes only the comments whose block is in the sent text", () => {
    const [a, b, c] = [add({ note: "a" }), add({ note: "b" }), add({ note: "c" })];
    consumeSent("t1", "my words\n\n" + sent(a!, c!));
    expect(getLineComments("t1").map((x) => x.id)).toEqual([b!.id]);
  });

  it("does not match a block whose note was edited in the box, or text that only mentions the header", () => {
    const a = add({ note: "a" });
    consumeSent("t1", sent(a).replace("> a", "> a, edited"));
    consumeSent("t1", "see [review] f.ts:3-4 (new) above");
    expect(getLineComments("t1")).toHaveLength(1);
  });

  it("matches a moved comment by its text, not its range", () => {
    const a = add({ note: "a" });
    const text = sent(a);
    reanchorFile("t1", "f.ts", SHIFTED);
    expect(getLineComments("t1")[0]!.start).toBe(5);
    consumeSent("t1", text);
    expect(getLineComments("t1")).toEqual([]);
  });

  it("changes nothing for text with no blocks", () => {
    add();
    consumeSent("t1", "just a message");
    expect(getLineComments("t1")).toHaveLength(1);
  });
});

describe("commentView", () => {
  it("is in message when the draft holds the block, derived each time", () => {
    const c = add();
    expect(commentView(c, "")).toBe("pending");
    expect(commentView(c, "hi\n\n" + formatReviewBlock(c))).toBe("in message");
    expect(commentView(c, "hi")).toBe("pending");
    expect(commentView({ ...c, state: "outdated" }, "")).toBe("outdated");
    expect(commentView({ ...c, state: "moved" }, "")).toBe("moved");
  });
});
