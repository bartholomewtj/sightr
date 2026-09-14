import { describe, expect, it } from "vitest";

import { AGENTS, AGENT_FAMILIES, AGENT_IDS, canonicalAgent, descriptorFor } from "@shared/agents";
import { AGENT_BRANDS } from "@/components/agent-icon-data";
import { CATALOG } from "@/lib/agent-commands";
import { ADAPTER_AGENTS } from "@/lib/harness/registry";

// Keep the descriptor as the compiler/runtime seam for all browser-side agent tables.
describe("agent descriptors", () => {
  it("cover every derived browser table", () => {
    expect(new Set(AGENT_IDS).size).toBe(AGENTS.length);
    for (const agent of AGENTS) {
      expect(descriptorFor(agent.id)).toBe(agent);
      expect(AGENT_FAMILIES).toContain(agent.family);
      for (const prefix of agent.prefixes) {
        expect(canonicalAgent(prefix)).toBe(agent.id);
        expect(canonicalAgent(`${prefix}-x`)).toBe(agent.id);
      }
      expect(canonicalAgent(agent.id)).toBe(agent.id);
      expect(CATALOG[agent.id]).toEqual(agent.catalog ?? []);
      if ("brand" in agent) expect(AGENT_BRANDS[agent.id]).toBe(agent.brand);
    }
  });

  it("covers every harness adapter id, including both Antigravity spellings", () => {
    expect([...ADAPTER_AGENTS].sort()).toEqual(
      ["agy", "antigravity", "claude", "cursor", "grok", "pi"].sort(),
    );
    for (const adapter of ADAPTER_AGENTS) {
      const descriptor = AGENTS.find((agent) => agent.id === adapter || (agent.prefixes as readonly string[]).includes(adapter));
      expect(descriptor).toBeDefined();
      expect(canonicalAgent(adapter)).toBe(descriptor?.id);
    }
  });

  it("gives AGY a family scope and an icon", () => {
    expect(canonicalAgent("agy")).toBe("agy");
    expect(canonicalAgent("antigravity")).toBe("agy");
    expect(AGENT_BRANDS.agy).toBeDefined();
  });
});
