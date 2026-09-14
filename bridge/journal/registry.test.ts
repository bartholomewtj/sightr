import { describe, expect, test } from "bun:test";

import { AGENTS } from "../../shared/agents.ts";
import { adapterFor, buildJournalRegistry, journalAgents } from "./registry.ts";

// The registry is the SINGLE decision site for "which agents have a journal". These tests pin the
// two properties that keep it from rotting: keys come from the adapters themselves, and a hostile
// agent name can't resolve to something that isn't an adapter.

const roots = { claude: ["/c"], pi: ["/p"], grok: ["/g"], cursor: ["/cur"] };

describe("buildJournalRegistry", () => {
  test("serves the four verified harnesses", () => {
    expect(journalAgents(buildJournalRegistry(roots))).toEqual(["claude", "cursor", "grok", "pi"]);
  });

  test("every key IS its adapter's own agent string and descriptor", () => {
    const registry = buildJournalRegistry(roots);
    for (const [key, adapter] of Object.entries(registry)) {
      expect(adapter.agent).toBe(key);
      expect(AGENTS.some((agent) => agent.id === key && "journal" in agent)).toBe(true);
    }
    const journalIds = AGENTS.filter((agent) => "journal" in agent).map((agent) => agent.id).sort();
    expect(journalIds).toEqual(Object.keys(registry).sort() as typeof journalIds);
  });
});

describe("adapterFor", () => {
  const registry = buildJournalRegistry(roots);

  test.each(["claude", "pi", "grok", "cursor"])("resolves %s", (agent) => {
    expect(adapterFor(registry, agent)?.agent).toBe(agent);
  });

  test("an agent with no journal is undefined, not a throw", () => {
    expect(adapterFor(registry, "aider")).toBeUndefined();
    expect(adapterFor(registry, undefined)).toBeUndefined();
  });

  // The agent string comes from Herdr, but it ORIGINATES in an agent's own report — so an inherited
  // Object.prototype key must not resolve to a function masquerading as an adapter.
  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "%s does not resolve to a non-adapter",
    (key) => {
      expect(adapterFor(registry, key)).toBeUndefined();
    },
  );
});
