import { beforeEach, describe, expect, it } from "vitest";

import {
  dumpTail,
  elapsed,
  journalHasAnyUser,
  journalHasUser,
  loadPendingUsers,
  mergePendingUsers,
  PENDING_USER_UUID,
  savePendingUsers,
  thinkSnip,
} from "./thinking-pulse";
import type { Block } from "./blocks";
import type { TranscriptEntry } from "./types";

function raw(texts: string[]): Block {
  return {
    kind: "raw",
    lines: texts.map((text) => ({ segments: [{ text, style: {}, muted: false }] })),
  };
}

function user(text: string, uuid = "u"): TranscriptEntry {
  return { uuid, ts: "2026-09-02T00:00:00.000Z", role: "user", parts: [{ kind: "text", text }] };
}

describe("thinkSnip", () => {
  it("returns the last three sentences, one per line, when the text ends on punctuation", () => {
    expect(thinkSnip("One. Two. Three? Four!")).toBe("Two.\nThree?\nFour!");
  });

  it("returns every sentence when there are fewer than three", () => {
    expect(thinkSnip("First thought. Second thought!")).toBe("First thought.\nSecond thought!");
  });

  it("returns the last 240 characters when there is no finished sentence", () => {
    const body = "x".repeat(300);
    expect(thinkSnip(body)).toBe(body.slice(-240));
  });

  it("collapses whitespace", () => {
    expect(thinkSnip("  hello   there  ")).toBe("hello there");
  });
});

describe("elapsed", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(1000)).toBe("0:01");
    expect(elapsed(100_000)).toBe("1:40");
  });

  it("does not go negative", () => {
    expect(elapsed(-50)).toBe("0:00");
  });
});

describe("dumpTail", () => {
  it("joins the last non-blank raw lines", () => {
    expect(dumpTail([raw(["old", "", "Puzzling… (1m 2s)"])], 8)).toBe("old Puzzling… (1m 2s)");
  });

  it("ignores lifted dialog blocks", () => {
    const dialog = { kind: "prompt-select", lines: [{ segments: [{ text: "1. Yes" }] }] } as Block;
    expect(dumpTail([raw(["thinking about the file"]), dialog], 8)).toBe("thinking about the file");
  });
});

describe("journalHasUser", () => {
  it("matches any user turn after collapsing whitespace", () => {
    const entries = [user("old"), user("looks   good")];
    expect(journalHasUser(entries, "looks good")).toBe(true);
    expect(journalHasUser(entries, "old")).toBe(true);
  });

  it("skips a trailing assistant turn to find the user", () => {
    const entries: TranscriptEntry[] = [
      user("looks good"),
      { uuid: "a", ts: "", role: "assistant", parts: [{ kind: "text", text: "ok" }] },
    ];
    expect(journalHasUser(entries, "looks good")).toBe(true);
  });

  it("is false when no user turn matches", () => {
    expect(journalHasUser([user("what changed today?")], "looks good")).toBe(false);
    expect(journalHasUser([], "looks good")).toBe(false);
  });
});

describe("journalHasAnyUser", () => {
  it("is true when a user turn has speech", () => {
    expect(journalHasAnyUser([user("grok")])).toBe(true);
  });

  it("is false when the journal is empty or assistant-only", () => {
    expect(journalHasAnyUser([])).toBe(false);
    expect(
      journalHasAnyUser([{ uuid: "a", ts: "", role: "assistant", parts: [{ kind: "text", text: "ok" }] }]),
    ).toBe(false);
  });
});

describe("mergePendingUsers", () => {
  const opening = { text: "grok", at: 1, opening: true as const };
  const follow = { text: "/icm-review", at: 2, opening: false as const };

  it("appends a follow-up that the journal does not have yet", () => {
    const entries = [user("/icm-review")];
    const merged = mergePendingUsers(entries, [{ text: "also this", at: 3, opening: false }]);
    expect(merged.map((e) => userSpeechOrText(e))).toEqual(["/icm-review", "also this"]);
    expect(merged.at(-1)?.uuid).toBe(PENDING_USER_UUID);
    expect(merged.at(-1)?.ts).toBe("");
  });

  it("puts an unmatched opening send in front of later journal turns", () => {
    const entries = [
      user("/icm-review"),
      { uuid: "a", ts: "", role: "assistant" as const, parts: [{ kind: "text" as const, text: "on it" }] },
    ];
    const merged = mergePendingUsers(entries, [opening]);
    expect(merged.map((e) => userSpeechOrText(e))).toEqual(["grok", "/icm-review", "on it"]);
    expect(merged[0]?.uuid).toBe(PENDING_USER_UUID);
  });

  it("keeps an opening send in front when a later queued send has landed", () => {
    const entries = [user("/icm-review")];
    const merged = mergePendingUsers(entries, [opening, follow]);
    expect(merged.map((e) => userSpeechOrText(e))).toEqual(["grok", "/icm-review"]);
  });

  it("drops a pending send once the journal has it", () => {
    expect(mergePendingUsers([user("grok")], [opening])).toEqual([user("grok")]);
  });
});

describe("pending user store", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips a queue and clears on empty", () => {
    const pane = "w1:p2";
    const queued = [{ text: "grok", at: 1, opening: true }];
    savePendingUsers(pane, queued);
    expect(loadPendingUsers(pane)).toEqual(queued);
    savePendingUsers(pane, []);
    expect(loadPendingUsers(pane)).toEqual([]);
  });
});

function userSpeechOrText(entry: TranscriptEntry): string {
  const part = entry.parts[0];
  return part && "text" in part ? part.text : "";
}
