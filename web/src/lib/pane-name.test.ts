import { describe, expect, it } from "vitest";

import { paneParts, paneTitleInTab } from "./pane-name";
import type { AgentView } from "./types";

function pane(over: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w0:p1",
    workspaceId: "w0",
    workspaceLabel: "moonward_os",
    workspaceNumber: 1,
    tabId: "w0:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/kon/dev/moonward",
    focused: false,
    ...over,
  };
}

/** What the row shows: the two spans are rendered side by side, so the assertions read them joined.
 *  They stay SEPARATE in the DOM on purpose — the project must be able to truncate before the tab
 *  does, which a single joined string cannot express. */
const join = (p: { project: string; tab: string | null }) =>
  p.tab ? `${p.project} · ${p.tab}` : p.project;
const joined = (pane: AgentView) => join(paneParts(pane));

describe("paneParts — the title line", () => {
  it("is project · tab when the tab has a label", () => {
    expect(joined(pane({ tabLabel: "fix-auth" }))).toBe("moonward_os · fix-auth");
  });

  it("falls back to the project alone when the bridge dropped the tab label", () => {
    // An unlabelled tab in a single-tab space arrives with tabLabel absent (meaningfulTabLabel),
    // so the row must not render a dangling separator.
    expect(joined(pane())).toBe("moonward_os");
  });

  it("never says 'claude'", () => {
    expect(joined(pane({ tabLabel: "fix-auth" }))).not.toContain("claude");
    expect(joined(pane())).not.toContain("claude");
  });

  it("falls back to the workspace id if a space somehow has no label", () => {
    expect(joined(pane({ workspaceLabel: "" }))).toBe("w0");
  });
});

describe("paneParts — the second line", () => {
  it("prefers a user-set pane label", () => {
    const t = paneParts(pane({ paneLabel: "hand-named", sessionName: "auto-named" }));
    expect(t.secondary).toBe("hand-named");
  });

  it("falls back to Herdr's live agent name, then Claude's /rename session name", () => {
    expect(paneParts(pane({ agentName: "planner-7dba2785", sessionName: "oauth-refactor" })).secondary)
      .toBe("planner-7dba2785");
    expect(paneParts(pane({ sessionName: "oauth-refactor" })).secondary).toBe("oauth-refactor");
  });

  it("falls back to a summary token before the terminal title", () => {
    expect(paneParts(pane({ summary: "indexing auth", terminalTitle: "Read foo" })).secondary)
      .toBe("indexing auth");
  });

  it("falls back to the terminal title — what the pane says it is doing", () => {
    expect(paneParts(pane({ terminalTitle: "Reconcile the book lists" })).secondary).toBe(
      "Reconcile the book lists",
    );
  });

  it("lets a hand-set name outrank the terminal title", () => {
    // A name you chose must not be overwritten by one the process rewrites every turn.
    const over = { terminalTitle: "Reconcile the book lists" };
    expect(paneParts(pane({ ...over, paneLabel: "hand-named" })).secondary).toBe("hand-named");
    expect(paneParts(pane({ ...over, sessionName: "oauth-refactor" })).secondary).toBe(
      "oauth-refactor",
    );
  });

  it("falls back to a shortened cwd", () => {
    expect(paneParts(pane()).secondary).toBe("~/dev/moonward");
  });

  it("prefers the terminal title over the cwd — a project's herd shares one cwd", () => {
    expect(paneParts(pane({ terminalTitle: "Fixing the parser" })).secondary).toBe(
      "Fixing the parser",
    );
  });

  it("tells apart several agents sitting in ONE project and tab", () => {
    // The herd this change exists for: same project, same cwd, no hand-set names. Before the title
    // was read, all three rows rendered identically.
    const rendered = [
      "Custom UI for Sightr",
      "Read Notes From Underground",
      "Reconcile book lists",
    ].map((terminalTitle) => {
      const p = paneParts(pane({ terminalTitle }));
      return `${join(p)}|${p.secondary}`;
    });
    expect(new Set(rendered).size).toBe(3);
  });

  it("is null when there is nothing to say", () => {
    expect(paneParts(pane({ cwd: "" })).secondary).toBeNull();
  });

  it("keeps the pane's own name even when the tab is labelled — nothing is lost", () => {
    const t = paneParts(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(join(t)).toBe("moonward_os · fix-auth");
    expect(t.secondary).toBe("oauth-refactor");
  });

  it("does not repeat the tab or project as the second line — 'Main · Sightr' over 'Sightr'", () => {
    // Herdr names a new tab after its pane, so the terminal title and the tab label coincide.
    const t = paneParts(pane({ tabLabel: "Sightr", terminalTitle: "sightr" }));
    expect(join(t)).toBe("moonward_os · Sightr");
    expect(t.secondary).toBe("~/dev/moonward"); // falls through to the cwd rule
    // A hand-set name equal to the project is the same repetition.
    expect(paneParts(pane({ paneLabel: "moonward_os", cwd: "" })).secondary).toBeNull();
    // Only an EXACT repeat is dropped — a name that adds a word still shows.
    expect(paneParts(pane({ tabLabel: "Sightr", terminalTitle: "Sightr: fixing nav" })).secondary).toBe("Sightr: fixing nav");
  });
});

describe("paneParts — shell panes", () => {
  it("names a shell by its place, not by the word 'shell'", () => {
    const t = paneParts(pane({ kind: "shell", agent: "shell", tabLabel: "scratch" }));
    expect(join(t)).toBe("moonward_os · scratch");
  });
});

describe("paneParts — the cwd fallback only when it says something", () => {
  it("drops the cwd when the directory is just the project again", () => {
    // The space is named after its directory on almost every row, so the fallback was printing
    // line 1 twice.
    expect(paneParts(pane({ workspaceLabel: "sightr", cwd: "/home/kon/dev/ai/sightr" })).secondary)
      .toBeNull();
  });

  it("is case-insensitive about that match", () => {
    expect(paneParts(pane({ workspaceLabel: "Sightr", cwd: "/home/kon/dev/ai/sightr" })).secondary)
      .toBeNull();
  });

  it("KEEPS the cwd when the pane sits somewhere else — a worktree or a subdir", () => {
    expect(paneParts(pane({ workspaceLabel: "sightr", cwd: "/home/kon/dev/ai/sightr/web" })).secondary)
      .toBe("~/dev/ai/sightr/web");
  });

  it("still prefers the pane's own name over either", () => {
    const t = paneParts(pane({ workspaceLabel: "sightr", cwd: "/home/kon/dev/ai/sightr", sessionName: "oauth" }));
    expect(t.secondary).toBe("oauth");
  });
});

describe("paneTitleInTab — inside a space view, where project and tab are already established", () => {
  it("leads with the pane's own name, since repeating project · tab would say nothing", () => {
    const t = paneTitleInTab(pane({ tabLabel: "fix-auth", sessionName: "oauth-refactor" }));
    expect(t.primary).toBe("oauth-refactor");
    expect(t.secondary).toBe("~/dev/moonward");
  });

  it("falls back through paneDisplayName's precedence: label, live name, session name, then agent", () => {
    expect(paneTitleInTab(pane({ paneLabel: "hand-named", sessionName: "auto" })).primary).toBe("hand-named");
    expect(paneTitleInTab(pane({ agentName: "planner-7dba2785" })).primary).toBe("planner-7dba2785");
    expect(paneTitleInTab(pane()).primary).toBe("claude");
    expect(paneTitleInTab(pane({ kind: "shell", agent: "shell" })).primary).toBe("shell");
  });
});
