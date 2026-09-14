import { describe, expect, it } from "vitest";
import { AGENT_FAMILIES, rowsFor } from "./operator-scope";

describe("AGY operator scoping", () => {
  it("is a declared operator family", () => {
    expect(AGENT_FAMILIES).toContain("agy");
  });
  it("matches AGY family rows and Antigravity variants", () => {
    const row = { agent: "agy", command: "/deploy" };
    expect(rowsFor([row], "agy", (r) => r.command)).toEqual([row]);
    expect(rowsFor([row], "antigravity", (r) => r.command)).toEqual([row]);
    expect(rowsFor([row], "claude", (r) => r.command)).toEqual([]);
  });

  it("keeps exact AGY scopes narrow and lets exact rows beat family rows", () => {
    const rows = [
      { agent: "agy", command: "/deploy", value: "family" },
      { agent: "antigravity", command: "/deploy", value: "exact" },
    ];
    expect(rowsFor(rows, "antigravity", (r) => r.command)[0]?.value).toBe("exact");
    expect(rowsFor([{ agent: "agy-cli", command: "/deploy" }], "agy", (r) => r.command)).toEqual([]);
  });

  it("keeps an unscoped row global", () => {
    const row = { agent: undefined, command: "/deploy" };
    expect(rowsFor([row], "agy", (r) => r.command)).toEqual([row]);
  });
});
