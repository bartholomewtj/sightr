import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines, type AutocompleteBlock, type Block, type RawBlock } from "@/lib/blocks";
import {
  hasParsedDialog,
  noteDialogPresence,
  resetDialogPresence,
  withDialogPresence,
} from "@/lib/dialog-presence";
import { buildBlocks } from "@/lib/harness";
import { spaceTriageMap } from "@/lib/spaces";
import { bucketOf } from "@/lib/triage";
import type { AgentStatus, AgentView } from "@/lib/types";

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");

function fixtureBlocks(filename: string, agent: string): Block[] {
  const raw = readFileSync(join(PANES_DIR, filename), "utf8");
  const lines = splitLines(parseAnsi(raw));
  return buildBlocks(lines, { agent });
}

function makeAgent(
  paneId: string,
  status: AgentStatus = "working",
  partial: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "grok",
    status,
    cwd: "/home/test",
    focused: false,
    ...partial,
  };
}

describe("dialog-presence", () => {
  beforeEach(() => {
    resetDialogPresence();
  });

  describe("hasParsedDialog", () => {
    it("returns true for real fixtures with parsed ask cards", () => {
      expect(hasParsedDialog(fixtureBlocks("grok--ask-color.txt", "grok"))).toBe(true);
      expect(hasParsedDialog(fixtureBlocks("grok--ask-light-gutter.txt", "grok"))).toBe(true);
      expect(hasParsedDialog(fixtureBlocks("claude--wizard-q1.txt", "claude"))).toBe(true);
      expect(hasParsedDialog(fixtureBlocks("claude--select-preview.txt", "claude"))).toBe(true);
    });

    it("returns false for real fixtures without dialogs", () => {
      expect(hasParsedDialog(fixtureBlocks("grok--working.txt", "grok"))).toBe(false);
      expect(hasParsedDialog(fixtureBlocks("grok--done.txt", "grok"))).toBe(false);
      expect(hasParsedDialog(fixtureBlocks("claude--working.txt", "claude"))).toBe(false);
      expect(hasParsedDialog(fixtureBlocks("claude--done.txt", "claude"))).toBe(false);
    });

    it("returns false for synthetic non-dialog blocks (raw, autocomplete)", () => {
      const rawBlock: RawBlock = { kind: "raw", lines: [] };
      expect(hasParsedDialog([rawBlock])).toBe(false);

      const autoBlock: AutocompleteBlock = {
        kind: "autocomplete",
        autocomplete: { entries: [] },
        lines: [],
      };
      expect(hasParsedDialog([autoBlock])).toBe(false);
    });
  });

  describe("store", () => {
    it("returns same array reference when store is empty", () => {
      const arr = [makeAgent("p1"), makeAgent("p2")];
      expect(withDialogPresence(arr)).toBe(arr);
    });

    it("notes dialog presence for p1 and keeps p2 as the same object", () => {
      const p1 = makeAgent("p1", "working", { lastActiveAt: 5 });
      const p2 = makeAgent("p2", "working", { lastActiveAt: 10 });

      const firstNote = noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });
      expect(firstNote).toBe(true);

      const repeatNote = noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });
      expect(repeatNote).toBe(false);

      const result = withDialogPresence([p1, p2]);
      expect(result[0]!.dialogPresent).toBe(true);
      expect(result[0]!.paneId).toBe("p1");
      expect(result[1]).toBe(p2);

      const clearNote = noteDialogPresence("p1", false, { status: "working", lastActiveAt: 5 });
      expect(clearNote).toBe(true);

      const afterClear = withDialogPresence([p1, p2]);
      expect(afterClear).toBe(afterClear);
      expect(afterClear[0]!.dialogPresent).toBeUndefined();
    });

    it("drops the flag when status changes (working -> done)", () => {
      noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });

      const doneAgent = makeAgent("p1", "done", { lastActiveAt: 5 });
      const result = withDialogPresence([doneAgent]);
      expect(result[0]!.dialogPresent).toBeUndefined();

      // Stays dropped on the next call
      const nextResult = withDialogPresence([doneAgent]);
      expect(nextResult[0]!.dialogPresent).toBeUndefined();
    });

    it("drops the flag when lastActiveAt changes", () => {
      noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });

      const movedAgent = makeAgent("p1", "working", { lastActiveAt: 10 });
      const result = withDialogPresence([movedAgent]);
      expect(result[0]!.dialogPresent).toBeUndefined();

      // Stays dropped on the next call
      const nextResult = withDialogPresence([movedAgent]);
      expect(nextResult[0]!.dialogPresent).toBeUndefined();
    });

    it("prunes a pane absent from a snapshot so it is not flagged when reappearing without a new note", () => {
      noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });

      // Snapshot without p1
      const p2 = makeAgent("p2", "working");
      withDialogPresence([p2]);

      // Snapshot where p1 reappears
      const p1 = makeAgent("p1", "working", { lastActiveAt: 5 });
      const result = withDialogPresence([p1]);
      expect(result[0]!.dialogPresent).toBeUndefined();
    });

    it("evicts the oldest pane past MAX_PANES (20) after 21 panes are noted", () => {
      for (let i = 1; i <= 21; i++) {
        noteDialogPresence(`p${i}`, true, { status: "working", lastActiveAt: i });
      }

      // p1 was oldest, so p1 should be evicted; p2..p21 should have dialogPresent
      const agents = Array.from({ length: 21 }, (_, i) =>
        makeAgent(`p${i + 1}`, "working", { lastActiveAt: i + 1 }),
      );
      const result = withDialogPresence(agents);
      expect(result[0]!.dialogPresent).toBeUndefined(); // p1
      expect(result[1]!.dialogPresent).toBe(true); // p2
      expect(result[20]!.dialogPresent).toBe(true); // p21
    });
  });

  describe("integration", () => {
    it("working grok agent noted true gives bucketOf 'needs' and spaceTriageMap 'needs'", () => {
      const grokAgent = makeAgent("p1", "working", { agent: "grok", lastActiveAt: 5 });
      noteDialogPresence("p1", true, { status: "working", lastActiveAt: 5 });

      const enriched = withDialogPresence([grokAgent]);
      expect(enriched[0]!.dialogPresent).toBe(true);
      expect(bucketOf(enriched[0]!)).toBe("needs");

      const spaces = spaceTriageMap(enriched);
      expect(spaces.get(grokAgent.workspaceId)).toBe("needs");
    });
  });
});
