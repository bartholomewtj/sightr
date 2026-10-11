import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(resolve(import.meta.dirname, name), "utf8");

// Spec 21: the phone document must not scroll. Desktop already had this frame under
// html.sightr-desktop; the rule is now unconditional, so phone gets the same lock and the
// desktop selector is gone rather than duplicated.
const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");

function frameRule(): string {
  const start = css.indexOf("html,");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("phone shell lock", () => {
  it("pins html, body and #root to the viewport with overflow hidden", () => {
    const rule = frameRule();
    expect(rule).toContain("height: 100dvh");
    expect(rule).toContain("overflow: hidden");
  });

  it("does not keep a separate desktop-only frame", () => {
    expect(css).not.toMatch(/html\.sightr-desktop[\s\S]{0,80}overflow:\s*hidden/);
  });

  it("still stops the document from chaining a pull into the browser", () => {
    expect(css).toContain("overscroll-behavior-y: none");
  });
});

describe("pull never reloads the page", () => {
  it.each([
    "hooks/use-pull-to-refresh.ts",
    "components/pull-indicator.tsx",
    "components/ui/chat/chat-message-list.tsx",
    "routes/tree.tsx",
  ])("%s does not call location.reload", (name) => {
    expect(read(name)).not.toMatch(/location\.reload/);
  });
});
