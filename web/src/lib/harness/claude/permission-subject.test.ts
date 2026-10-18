import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLines } from "../../blocks";
import { parseDialog } from "../dialog-kit";
import { claudePermissionSubject, SUBJECT_MAX_LINES } from "./permission-subject";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const pane = (name: string) => readFileSync(join(FIXTURES, "panes", name), "utf8");
/** Live read, 2026-10-18 (Claude Code 2.1.302, Haiku, `--permission-mode manual`): a Read outside the cwd. */
const live = (name: string) => readFileSync(join(FIXTURES, "permission-subject", name), "utf8");

const subjectOf = (text: string) => claudePermissionSubject(parseLines(text), "Do you want to proceed?");

/** A permission dialog as Claude paints it, plain text. */
function dialog(subject: string[], question = "Do you want to proceed?"): string {
  return [
    "● Bash(…)",
    "",
    "─".repeat(60),
    ...subject,
    "",
    ` ${question}`,
    " ❯ 1. Yes",
    "   2. No",
    "",
    " Esc to cancel · Tab to amend",
  ].join("\n");
}

describe("claudePermissionSubject", () => {
  it("a Bash command: 'Run command', the command, and its dim description", () => {
    expect(subjectOf(pane("claude--permission-bash.txt"))).toEqual({
      title: "Run command",
      target: "mkfifo fixture-fifo",
      detail: "Create a named pipe (FIFO)",
    });
  });

  it("a Read outside the cwd (live): 'Read file' and the bare path, the '1 of 2' counter dropped", () => {
    expect(subjectOf(live("claude--read-outside.txt"))).toEqual({
      title: "Read file",
      target: "C:\\Users\\sandbox\\AppData\\Local\\Temp\\claude\\C--claudeOS\\7f0ebd9f-0eff-4f9b-a880-4f979b275e41\\scratchpad\\rough\\outside\\notes.md",
    });
  });

  it("the boxed layout (live, 2.1.302): the command from its `│` box, the dim description as detail", () => {
    expect(subjectOf(live("claude--bash-boxed.txt"))).toEqual({
      title: "Run command",
      target:
        'git status --short && git log --oneline -3 && echo "permission card check with a fairly long command line so it wraps on a phone"',
      detail: "Show short git status, last 3 commits, and echo check line",
    });
  });

  it("a boxed command that wrapped keeps one line per box row", () => {
    const text = dialog([" Bash command", " Two steps", "╌".repeat(60), " │ git add -A &&", " │ git commit -m x", "╌".repeat(60), " Permission rule Bash requires confirmation for this command."]);
    expect(subjectOf(text)?.target).toBe("git add -A &&\ngit commit -m x");
  });

  it("a file creation: the heading and the file name, never the diff", () => {
    expect(claudePermissionSubject(parseLines(pane("claude--permission-edit.txt")), "Do you want to create hello.txt?")).toEqual({
      title: "Create file",
      target: "hello.txt",
    });
  });

  it("a wrapped Read(...) argument is rejoined unbroken", () => {
    const text = dialog([" Read file", "╌".repeat(60), " Read(C:\\very\\long\\path\\that\\wr", "aps\\notes.md)", "╌".repeat(60)]);
    expect(subjectOf(text)).toEqual({ title: "Read file", target: "C:\\very\\long\\path\\that\\wraps\\notes.md" });
  });

  it("a multi-line command keeps its lines; a huge one is capped", () => {
    expect(subjectOf(dialog([" Bash command", "", "   git add -A &&", "   git status"]))?.target).toBe("git add -A &&\ngit status");
    const many = Array.from({ length: 50 }, (_, i) => `   echo ${i}`);
    expect(subjectOf(dialog([" Bash command", "", ...many]))?.target?.split("\n")).toHaveLength(SUBJECT_MAX_LINES);
  });

  it("no top rule in reach, or no question on screen: no subject", () => {
    expect(subjectOf(" Bash command\n\n   ls\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel")).toBeNull();
    expect(claudePermissionSubject(parseLines(pane("claude--permission-bash.txt")), "Something else?")).toBeNull();
  });
});

describe("parseDialog carries the subject", () => {
  it("Claude permissions get one; trust prompts and other agents' permissions do not", () => {
    expect(parseDialog("claude", pane("claude--permission-bash.txt"))?.subject).toEqual({
      title: "Run command",
      target: "mkfifo fixture-fifo",
      detail: "Create a named pipe (FIFO)",
    });
    expect(parseDialog("claude", live("claude--read-outside.txt"))?.subject?.title).toBe("Read file");
    expect(parseDialog("claude", pane("claude--trust-prompt.txt"))?.subject).toBeUndefined();
    expect(parseDialog("cursor", pane("cursor--permission-command.txt"))?.subject).toBeUndefined();
  });

  it("the subject does not change what the bridge binds to", () => {
    const p = parseDialog("claude", pane("claude--permission-bash.txt"))!;
    expect(p.boundText).not.toContain("Run command");
  });
});
