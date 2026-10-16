import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { permissionModeOf as claudeMode } from "./claude/chrome";
import { permissionModeOf as cursorMode } from "./cursor/chrome";
import { permissionModeOf as grokMode } from "./grok/chrome";

// The footer readers behind the live permission-mode switch (T08). The `claude--mode-*` captures are
// Claude Code 2.1.301 on 16 Oct 2026, one per shift+tab press (auto → manual → accept edits → plan).
// The rest are earlier live captures already in the fixture set.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const fixture = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

describe("permissionModeOf: claude", () => {
  it.each([
    ["claude--mode-auto.txt", "auto"],
    ["claude--mode-manual.txt", "manual"],
    ["claude--mode-accept-edits.txt", "acceptEdits"],
    ["claude--mode-plan.txt", "plan"],
    ["claude--draft-footer-empty.txt", "bypassPermissions"],
    ["claude--working.txt", "bypassPermissions"],
    ["claude--draft-wrapped.txt", "manual"],
  ])("%s → %s", (name, mode) => {
    expect(claudeMode(fixture(name))).toBe(mode);
  });

  it("null when the box shows no mode (older builds in the default mode)", () => {
    expect(claudeMode(fixture("claude--fresh-idle.txt"))).toBeNull();
  });

  it("null when a dialog owns the screen", () => {
    expect(claudeMode(fixture("claude--permission-bash.txt"))).toBeNull();
    expect(claudeMode(fixture("claude--select-menu.txt"))).toBeNull();
  });

  it("does not read a mode phrase above the box", () => {
    const rule = "─".repeat(40);
    const lines = splitLines(parseAnsi(["⏸ plan mode on", rule, "❯ ", rule, "  ? for shortcuts"].join("\n")));
    expect(claudeMode(lines)).toBeNull();
  });
});

describe("permissionModeOf: grok", () => {
  it.each([
    ["grok--done.txt", "auto"],
    ["grok--working.txt", "bypassPermissions"],
    ["grok--startup.txt", null],
    ["grok--plan-approval.txt", null],
  ])("%s → %s", (name, mode) => {
    expect(grokMode(fixture(name))).toBe(mode);
  });
});

describe("permissionModeOf: cursor", () => {
  it.each([
    ["cursor--plan-idle.txt", "plan"],
    ["cursor--debug-idle.txt", "debug"],
    ["cursor--fresh-idle.txt", null],
  ])("%s → %s", (name, mode) => {
    expect(cursorMode(fixture(name))).toBe(mode);
  });
});
