import { describe, expect, it } from "vitest";

import { adapterFor, hasBlockGrammar } from "./registry";

// The single source of truth for "which agents get the block grammars". Both gates (the render
// pipeline's buildBlocks and agent-chat's status strip) route through the registry, so it is worth
// pinning directly — this re-homes the old grammar/agents predicate test onto the registry, which
// now derives the predicate from adapterFor().
describe("hasBlockGrammar", () => {
  // "Registered", not "verified": in HARNESS_CONTRIBUTING.md "verified" is a term of art meaning
  // live-verified against a real pane, which is the Tier-2 bar. Claude has cleared it; not every
  // adapter claims to. What this predicate actually answers is "does an adapter exist".
  it("is true for every registered adapter", () => {
    expect(hasBlockGrammar("claude")).toBe(true);
    expect(hasBlockGrammar("grok")).toBe(true);
    expect(hasBlockGrammar("agy")).toBe(true);
    expect(hasBlockGrammar("antigravity")).toBe(true);
    expect(hasBlockGrammar("cursor")).toBe(true);
    expect(hasBlockGrammar("pi")).toBe(true);
  });

  it("is false for every unregistered agent (no adapter ⇒ raw mirror)", () => {
    for (const agent of ["codex", "shell", "unknown", "Claude", "claude-code", "cursor-agent"]) {
      expect(hasBlockGrammar(agent)).toBe(false);
    }
  });

  it("does not prefix-match — grok-build / GROK are not the grok adapter", () => {
    expect(adapterFor("grok-build")).toBeUndefined();
    expect(adapterFor("GROK")).toBeUndefined();
    expect(hasBlockGrammar("grok-build")).toBe(false);
    expect(adapterFor("grok")?.agent).toBe("grok");
  });

  it("does not prefix-match — agy-cli / AGY / antigravity-cli are not the AGY adapter", () => {
    for (const agent of ["agy-cli", "AGY", "agyx", "antigravity-cli", "Antigravity"]) {
      expect(adapterFor(agent)).toBeUndefined();
      expect(hasBlockGrammar(agent)).toBe(false);
    }
    expect(adapterFor("agy")?.agent).toBe("agy");
    expect(adapterFor("antigravity")?.agent).toBe("antigravity");
  });

  it("does not prefix-match — cursor-agent / CURSOR are not the cursor adapter", () => {
    for (const agent of ["cursor-agent", "CURSOR", "cursorx"]) {
      expect(adapterFor(agent)).toBeUndefined();
      expect(hasBlockGrammar(agent)).toBe(false);
    }
    expect(adapterFor("cursor")?.agent).toBe("cursor");
  });

  it("does not prefix-match — pi-go / PI / pix / pi.dev are not the pi adapter", () => {
    for (const agent of ["pi-go", "PI", "pix", "pi.dev"]) {
      expect(adapterFor(agent)).toBeUndefined();
      expect(hasBlockGrammar(agent)).toBe(false);
    }
    expect(adapterFor("pi")?.agent).toBe("pi");
  });

  it("is false for an absent agent", () => {
    expect(hasBlockGrammar(undefined)).toBe(false);
  });

  // Inherited Object.prototype keys must not resolve to a truthy non-adapter (which would crash the
  // render path calling `.buildBlocks` on `Object.prototype.toString`). `Object.hasOwn` gates the lookup.
  it("is false for inherited Object.prototype keys (no prototype-chain lookup)", () => {
    for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(adapterFor(key)).toBeUndefined();
      expect(hasBlockGrammar(key)).toBe(false);
    }
  });
});
