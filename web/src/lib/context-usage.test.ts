import { describe, expect, it } from "vitest";

import { contextUsageFrom } from "./context-usage";

describe("contextUsageFrom", () => {
  it("reads Claude's ctx:N% and CTX:N% spellings", () => {
    expect(contextUsageFrom("  [Opus] ~/webapp  ctx:33%  main")).toBe("33%");
    expect(contextUsageFrom("  CTX:20% CACHE:100% LIMITS 5h:22%")).toBe("20%");
  });

  it("reads Grok's N% ctx spelling", () => {
    expect(contextUsageFrom("grok-shell-status-line │ Grok 4.6 │ 12% ctx")).toBe("12%");
  });

  it("reads Grok's header used/window count", () => {
    expect(contextUsageFrom("/tmp/sandbox                    20K / 500K")).toBe("20K/500K");
    expect(contextUsageFrom("1.5K / 500K")).toBe("1.5K/500K");
    expect(contextUsageFrom("8.5K / 1.0M")).toBe("8.5K/1.0M");
    expect(contextUsageFrom("500 / 1.0M")).toBe("500/1.0M");
    expect(contextUsageFrom("1.5k/500k")).toBe("1.5k/500k");
  });

  it("reads Pi's footer fill/window count", () => {
    expect(contextUsageFrom("↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium")).toBe("4.1%/200k");
    expect(contextUsageFrom("0.0%/128k")).toBe("0.0%/128k");
    expect(contextUsageFrom("100.0%/1.0M")).toBe("100.0%/1.0M");
    expect(contextUsageFrom("4.1% / 200k")).toBe("4.1%/200k");
  });

  it("prefers a fill percentage over a used/window count in the same haystack", () => {
    expect(contextUsageFrom("[Opus] ctx:33% · 20K / 500K")).toBe("33%");
  });

  it("rejects a percentage that is not a fill level", () => {
    expect(contextUsageFrom("5h:22%/1h:20m 7d:26%")).toBeNull();
    expect(contextUsageFrom("cache 100%")).toBeNull();
    expect(contextUsageFrom("151.5k tokens")).toBeNull();
    expect(contextUsageFrom("?/200k (auto)")).toBeNull();
    expect(contextUsageFrom("2026/09")).toBeNull();
    expect(contextUsageFrom("src/lib")).toBeNull();
    expect(contextUsageFrom("")).toBeNull();
  });

  it("rejects a ctx percentage outside 0–100", () => {
    expect(contextUsageFrom("ctx:101%")).toBeNull();
  });
});
