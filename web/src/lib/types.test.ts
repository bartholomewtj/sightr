import { paneDisplayName } from "./types";
import type { AgentView } from "./types";

// The one place the pane display-name priority lives, so every surface (pill, card, sidebar, header)
// agrees: user label > Herdr live name > Claude /rename > summary > terminal title > harness/"shell".
function pane(overrides: Partial<AgentView> = {}): AgentView {
  return {
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind: "agent",
    ...overrides,
  };
}

describe("paneDisplayName", () => {
  it("prefers an explicit user label over everything", () => {
    expect(paneDisplayName(pane({ paneLabel: "deploy", sessionName: "auth-refactor" }))).toBe("deploy");
  });

  it("falls back to Herdr's live agent name when there's no label", () => {
    expect(paneDisplayName(pane({ agentName: "planner-7dba2785", sessionName: "auth-refactor" }))).toBe(
      "planner-7dba2785",
    );
  });

  it("falls back to Claude's /rename session name when there's no label or live name", () => {
    expect(paneDisplayName(pane({ sessionName: "auth-refactor" }))).toBe("auth-refactor");
  });

  it("falls back to a summary token before the terminal title", () => {
    expect(paneDisplayName(pane({ summary: "indexing auth", terminalTitle: "Read foo" }))).toBe(
      "indexing auth",
    );
  });

  it("falls back to the agent name when neither a label nor a session name is set", () => {
    expect(paneDisplayName(pane({ agent: "grok" }))).toBe("grok");
  });

  it("names a bare shell pane after its cwd directory before falling back to \"shell\"", () => {
    expect(
      paneDisplayName(pane({ kind: "shell", agent: "shell", cwd: "C:\\Users\\you\\Projects\\demo" })),
    ).toBe("demo");
    expect(paneDisplayName(pane({ kind: "shell", agent: "shell", cwd: "" }))).toBe("shell");
  });

  it("still lets a user label win on a shell pane", () => {
    expect(paneDisplayName(pane({ kind: "shell", agent: "shell", paneLabel: "logs" }))).toBe("logs");
  });

  it("ignores a Windows Terminal profile default title in favour of the harness name", () => {
    expect(paneDisplayName(pane({ agent: "cursor", terminalTitle: "Windows PowerShell" }))).toBe("cursor");
  });

  it("ignores plugin and generic host titles in favour of the harness name", () => {
    expect(paneDisplayName(pane({ agent: "cursor", terminalTitle: "Terminal Session" }))).toBe("cursor");
    expect(paneDisplayName(pane({ agent: "cursor", terminalTitle: "Terminal browser" }))).toBe("cursor");
    expect(paneDisplayName(pane({ agent: "cursor", terminalTitle: "win-terminal-browser" }))).toBe("cursor");
  });

  it("still shows an explicit plugin shell label even when it matches a filtered terminal title", () => {
    expect(
      paneDisplayName(
        pane({ kind: "shell", agent: "shell", paneLabel: "win-terminal-browser", terminalTitle: "win-terminal-browser" }),
      ),
    ).toBe("win-terminal-browser");
  });
});
