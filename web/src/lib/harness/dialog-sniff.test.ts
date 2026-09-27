import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { lineText, parseLines } from "../blocks";
import { hasParsedDialog } from "../dialog-presence";
import { hasBlockingDialog, sniffsDialogs } from "./dialog-sniff";
import { adapterFor } from "./registry";

// The bridge reads a resting Cursor / Antigravity pane as plain text (`format: "text"`) from the
// visible viewport, 40 lines, and asks hasBlockingDialog. It must answer exactly what the browser's
// adapter would lift from the same pane, or the herd says "needs you" over a pane the chat view shows
// as plain transcript (or the reverse, which is the bug this exists to fix).

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const fixtures = (prefix: string) =>
  readdirSync(PANES_DIR)
    .filter((f) => f.startsWith(`${prefix}--`) && f.endsWith(".txt"))
    .sort();
const raw = (file: string) => readFileSync(join(PANES_DIR, file), "utf8");

/** What a `visible` / `text` read of the pane's last 40 rows looks like: no escapes. */
function visibleText(file: string, rows = 40): string {
  return parseLines(raw(file))
    .map(lineText)
    .slice(-rows)
    .join("\n");
}

/** Does the agent's adapter lift a dialog block from the full ANSI fixture? */
function adapterLiftsDialog(agent: string, file: string): boolean {
  const adapter = adapterFor(agent);
  if (!adapter) throw new Error(`no adapter for ${agent}`);
  return hasParsedDialog(adapter.buildBlocks(parseLines(raw(file))));
}

const CURSOR = fixtures("cursor");
const AGY = fixtures("agy");

describe("hasBlockingDialog — agrees with the adapter on every fixture", () => {
  it("has fixtures to check, and some of each kind", () => {
    expect(CURSOR.length).toBeGreaterThan(0);
    expect(AGY.length).toBeGreaterThan(0);
    expect(CURSOR.some((f) => adapterLiftsDialog("cursor", f))).toBe(true);
    expect(CURSOR.some((f) => !adapterLiftsDialog("cursor", f))).toBe(true);
    expect(AGY.some((f) => adapterLiftsDialog("agy", f))).toBe(true);
    expect(AGY.some((f) => !adapterLiftsDialog("agy", f))).toBe(true);
  });

  it.each(CURSOR)("cursor %s", (file) => {
    expect(hasBlockingDialog("cursor", visibleText(file))).toBe(adapterLiftsDialog("cursor", file));
  });

  it.each(AGY)("agy %s", (file) => {
    const expected = adapterLiftsDialog("agy", file);
    expect(hasBlockingDialog("agy", visibleText(file))).toBe(expected);
    expect(hasBlockingDialog("antigravity", visibleText(file))).toBe(expected);
  });

  it("accepts the ANSI read too", () => {
    for (const file of CURSOR) {
      expect(hasBlockingDialog("cursor", raw(file))).toBe(adapterLiftsDialog("cursor", file));
    }
  });
});

describe("hasBlockingDialog — negatives", () => {
  const OTHERS = [...fixtures("claude"), ...fixtures("grok"), ...fixtures("pi")];

  it.each(OTHERS)("%s is never a Cursor or Antigravity dialog", (file) => {
    const text = visibleText(file);
    expect(hasBlockingDialog("cursor", text)).toBe(false);
    expect(hasBlockingDialog("agy", text)).toBe(false);
    expect(hasBlockingDialog("antigravity", text)).toBe(false);
  });

  it("is false once output lands after the dialog", () => {
    const dialogs = [
      ...CURSOR.filter((f) => adapterLiftsDialog("cursor", f)).map((f) => ["cursor", f] as const),
      ...AGY.filter((f) => adapterLiftsDialog("agy", f)).map((f) => ["agy", f] as const),
    ];
    expect(dialogs.length).toBeGreaterThan(0);
    for (const [agent, file] of dialogs) {
      const text = visibleText(file) + "\n\nRan the command.\nAll 12 tests passed. Anything else?\n";
      expect({ file, dialog: hasBlockingDialog(agent, text) }).toEqual({ file, dialog: false });
    }
  });

  it("only sniffs exact agent strings", () => {
    const text = visibleText("cursor--permission-command.txt");
    expect(hasBlockingDialog("cursor", text)).toBe(true);
    for (const agent of ["claude", "grok", "pi", "Cursor", "cursor-agent", "cursor ", "agy2", "", "toString"]) {
      expect(hasBlockingDialog(agent, text)).toBe(false);
      expect(sniffsDialogs(agent)).toBe(false);
    }
    expect(["cursor", "agy", "antigravity"].every(sniffsDialogs)).toBe(true);
  });

  it("is false on an empty read", () => {
    expect(hasBlockingDialog("cursor", "")).toBe(false);
    expect(hasBlockingDialog("agy", "")).toBe(false);
  });
});
