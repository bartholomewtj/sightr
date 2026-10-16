import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyExpectedPrompt } from "@shared/prompt-binding";
import { parseLines, type Block } from "../blocks";
import { BOUND_TEXT_LINES, boundTextOf, DIALOG_KIT_AGENTS, dialogPipeline, parseDialog } from "./dialog-kit";
import { ADAPTER_AGENTS, adapterFor } from "./registry";

// The bridge parses a blocked pane's screen with parseDialog and answers it with the option's keys.
// It must lift exactly what the phone's adapter lifts from the same screen, or a card would offer a
// button the phone would not (or the reverse). Same contract as dialog-sniff.test.ts.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const raw = (file: string) => readFileSync(join(PANES_DIR, file), "utf8");
const fixtures = (prefix: string) =>
  readdirSync(PANES_DIR)
    .filter((f) => f.startsWith(`${prefix}--`) && f.endsWith(".txt"))
    .sort();

/** Fixture prefix per agent string (antigravity shares agy's captures). */
const PREFIX: Record<string, string> = { claude: "claude", cursor: "cursor", agy: "agy", antigravity: "agy", grok: "grok", pi: "pi" };

type DialogBlock = Exclude<Block, { kind: "raw" } | { kind: "autocomplete" }>;
const adapterDialog = (agent: string, file: string): DialogBlock | undefined =>
  adapterFor(agent)!
    .buildBlocks(parseLines(raw(file)))
    .findLast((b): b is DialogBlock => b.kind !== "raw" && b.kind !== "autocomplete");

const CASES = DIALOG_KIT_AGENTS.flatMap((agent) => fixtures(PREFIX[agent]!).map((file) => [agent, file] as const));

describe("dialog kit — the adapters' own pipelines", () => {
  it("covers exactly the agents that have adapters", () => {
    expect([...DIALOG_KIT_AGENTS].sort()).toEqual([...ADAPTER_AGENTS].sort());
  });

  it.each([...ADAPTER_AGENTS])("%s: the pipeline is the adapter's buildBlocks", (agent) => {
    expect(dialogPipeline(agent)).toBe(adapterFor(agent)!.buildBlocks);
  });

  it("has fixtures with and without dialogs", () => {
    expect(CASES.some(([a, f]) => adapterDialog(a, f) !== undefined)).toBe(true);
    expect(CASES.some(([a, f]) => adapterDialog(a, f) === undefined)).toBe(true);
  });
});

describe("parseDialog — agrees with the adapter on every fixture", () => {
  it.each(CASES)("%s %s", (agent, file) => {
    const block = adapterDialog(agent, file);
    const parsed = parseDialog(agent, raw(file));
    if (!block) {
      expect(parsed === null || parsed.kind === "password").toBe(true);
      return;
    }
    expect(parsed).not.toBeNull();
    const p = parsed!;
    // The binding the bridge will re-check is on the screen it came from, inside the matcher's tail.
    expect(verifyExpectedPrompt(raw(file), p.boundText)).toEqual({ ok: true });
    expect(p.boundText.split("\n").length).toBeLessThanOrEqual(BOUND_TEXT_LINES);
    switch (block.kind) {
      case "prompt-select": {
        const model = block.prompt;
        if (model.decision) {
          expect(p.via).toBe("whistlr");
          expect(p.options.every((o) => o.keys.length === 0)).toBe(true);
          break;
        }
        expect(p.kind).toBe(model.family === "permission" ? "permission" : model.family === "trust" ? "trust" : "question");
        expect(p.prompt).toBe(model.question);
        if (model.feedback?.focused) expect(p.options).toEqual([]);
        else expect(p.options.map((o) => ({ label: o.label, keys: o.keys }))).toEqual(model.options.map((o) => ({ label: o.label, keys: o.keys })));
        break;
      }
      case "menu":
        expect(p.kind).toBe("menu");
        expect(p.prompt).toBe(block.menu.title);
        expect(p.options.map((o) => o.keys)).toEqual(block.menu.actions.map((a) => a.keys));
        break;
      default:
        // wizard / multi-select / preview-select: a question with no options until T17.
        expect(p.kind).toBe("question");
        expect(p.options).toEqual([]);
    }
  });
});

describe("parseDialog — kinds and fields", () => {
  it("a Claude permission prompt is a permission with the adapter's digits", () => {
    const p = parseDialog("claude", raw("claude--permission-bash.txt"))!;
    expect(p.kind).toBe("permission");
    expect(p.prompt).toBe("Do you want to proceed?");
    expect(p.options.map((o) => o.keys)).toEqual([["1"], ["2"], ["3"]]);
    expect(p.options.some((o) => o.destructive)).toBe(false); // Claude has no deny list
  });

  it("trust prompts are trust", () => {
    expect(parseDialog("claude", raw("claude--trust-prompt.txt"))?.kind).toBe("trust");
    expect(parseDialog("cursor", raw("cursor--trust-workspace.txt"))?.kind).toBe("trust");
  });

  it("ask cards and plan approvals are questions", () => {
    expect(parseDialog("cursor", raw("cursor--ask-fruit.txt"))?.kind).toBe("question");
    expect(parseDialog("grok", raw("grok--ask-color.txt"))?.kind).toBe("question");
    expect(parseDialog("claude", raw("claude--select-menu.txt"))?.kind).toBe("question");
    expect(parseDialog("claude", raw("claude--plan-approval.txt"))?.kind).toBe("question");
  });

  it("the generic menu is a menu, its Esc marked destructive", () => {
    const p = parseDialog("claude", raw("claude--menu-model-picker.txt"))!;
    expect(p.kind).toBe("menu");
    expect(p.options.length).toBeGreaterThan(0);
    for (const o of p.options) expect(o.destructive === true).toBe(o.keys.includes("Escape"));
  });

  it("marks the adapters' own deny rows", () => {
    const cursor = parseDialog("cursor", raw("cursor--permission-command.txt"))!;
    expect(cursor.options.map((o) => [o.label, o.destructive === true])).toEqual([
      ["Run (once)", false],
      ["Skip", true],
    ]);
    const grok = parseDialog("grok", raw("grok--permission-rm.txt"))!;
    expect(grok.kind).toBe("permission");
    expect(grok.options.at(-1)!.destructive).toBe(true);
    expect(grok.options[0]!.destructive).toBeUndefined();
  });

  it("multi-step dialogs are questions with no options", () => {
    for (const [agent, file] of [
      ["claude", "claude--wizard-q1.txt"],
      ["claude", "claude--select-multiselect-single.txt"],
      ["claude", "claude--select-preview.txt"],
      ["cursor", "cursor--ask-multi-fruit.txt"],
      ["grok", "grok--ask-multi.txt"],
    ] as const) {
      const p = parseDialog(agent, raw(file));
      expect({ file, kind: p?.kind, options: p?.options }).toEqual({ file, kind: "question", options: [] });
    }
  });

  it("a draftr-marked card goes through whistlr: labels only, no keys", () => {
    const marker = "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb";
    const p = parseDialog("claude", `${raw("claude--select-menu.txt")}\n${marker}\n`)!;
    expect(p).toMatchObject({ kind: "question", via: "whistlr", decision: { thread: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", run: "5a81defb" } });
    expect(p.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Chat about this"]);
    expect(p.options.every((o) => o.keys.length === 0)).toBe(true);
  });

  it("a password prompt is password with no options", () => {
    const text = raw("claude--done.txt") + "\n$ sudo ls\n[sudo] password for bart: ";
    const p = parseDialog("claude", text)!;
    expect(p.kind).toBe("password");
    expect(p.prompt).toBe("[sudo] password for bart:");
    expect(p.options).toEqual([]);
  });

  it("a resting screen is null", () => {
    expect(parseDialog("claude", raw("claude--done.txt"))).toBeNull();
    expect(parseDialog("cursor", raw("cursor--fresh-idle.txt"))).toBeNull();
  });

  it("matches the agent string exactly", () => {
    const text = raw("claude--permission-bash.txt");
    for (const agent of ["Claude", "claude-code", "claude ", "shell", "", "toString", "constructor"]) {
      expect(parseDialog(agent, text)).toBeNull();
      expect(dialogPipeline(agent)).toBeUndefined();
    }
  });

  it("is null on an empty read", () => {
    expect(parseDialog("claude", "")).toBeNull();
    expect(parseDialog("claude", "\n\n  \n")).toBeNull();
  });

  it("boundText is the last 12 non-blank lines, SGR and trailing spaces removed", () => {
    const text = Array.from({ length: 20 }, (_, i) => `\x1b[1mline ${i}\x1b[0m   \n\n`).join("");
    expect(boundTextOf(text)).toBe(Array.from({ length: 12 }, (_, i) => `line ${i + 8}`).join("\n"));
  });
});

describe("dialog kit — leaf import closure", () => {
  // The bridge imports this file at runtime and its root typecheck runs before `web/` installs, so
  // nothing reachable from here may name a package (`react`, `@shared/...`, anything not relative).
  const closure = (entry: string) => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gms)) {
        const spec = m[1]!;
        if (!spec.startsWith(".")) {
          bad.push(`${file}: ${spec}`);
          continue;
        }
        const base = resolve(dirname(file), spec);
        const target = [base, `${base}.ts`, join(base, "index.ts")].find((p) => p.endsWith(".ts") && existsSync(p));
        if (!target) throw new Error(`cannot resolve ${spec} from ${file}`);
        visit(target);
      }
    };
    visit(entry);
    return { files: [...seen], bad };
  };

  it("imports no package, directly or transitively", () => {
    const { files, bad } = closure(join(import.meta.dirname, "dialog-kit.ts"));
    expect(bad).toEqual([]);
    // It really walked the adapters (a broken walker would pass vacuously).
    for (const leaf of ["claude/prompt-select.ts", "grok/ask.ts", "pi/ask.ts", "cursor/chrome.ts", "no-echo.ts"]) {
      expect(files.some((f) => f.replace(/\\/g, "/").endsWith(leaf))).toBe(true);
    }
  });
});
