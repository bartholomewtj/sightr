// T29: the text a line comment becomes in the composer, and the parser that reads it back.
import { describe, expect, it } from "vitest";

import {
  appendReviewBlocks,
  blockHash,
  blockKey,
  cutQuoteLine,
  formatReviewBlock,
  isInMessage,
  MAX_BLOCK_CHARS_PER_MESSAGE,
  MAX_COMMENTS_PER_MESSAGE,
  parseReviewBlocks,
  reviewBlocksIn,
  reviewUsage,
  type ReviewBlock,
} from "./reviewCommentContext";

const block = (over: Partial<ReviewBlock> = {}): ReviewBlock => ({
  path: "src/lib/foo.ts",
  start: 12,
  end: 14,
  side: "new",
  outdated: false,
  quote: ["+const a = 1;", " const b = 2;", "+const c = 3;"],
  note: "Rename `a` to say what it counts.\nSecond line of the note.",
  ...over,
});

const only = (text: string) => {
  const found = reviewBlocksIn(text);
  expect(found).toHaveLength(1);
  return found[0]!.block;
};

describe("formatReviewBlock", () => {
  it("writes the golden block", () => {
    expect(formatReviewBlock(block())).toBe(
      [
        "[review] src/lib/foo.ts:12-14 (new)",
        "```diff",
        "+const a = 1;",
        " const b = 2;",
        "+const c = 3;",
        "```",
        "> Rename `a` to say what it counts.",
        "> Second line of the note.",
      ].join("\n"),
    );
  });

  it("names a single line without a dash, the old side, and outdated", () => {
    const text = formatReviewBlock(block({ start: 7, end: 7, side: "old", outdated: true, quote: ["-gone"], note: "why" }));
    expect(text.split("\n")[0]).toBe("[review] src/lib/foo.ts:7 (old, outdated)");
  });

  it("starts with [ so it cannot open the slash menu or a harness mode", () => {
    expect(formatReviewBlock(block())[0]).toBe("[");
    expect(formatReviewBlock(block())).not.toMatch(/^[/!#]/);
  });

  it("uses a longer fence than any backtick run in the quote", () => {
    const text = formatReviewBlock(block({ quote: ["+const s = ```x```;", "+```` four ````"], note: "fence" }));
    expect(text).toContain("`````diff");
    expect(only(text).quote).toEqual(["+const s = ```x```;", "+```` four ````"]);
  });

  it("cuts a quoted line over 160 characters with an ellipsis, and the hash still uses the full line", () => {
    const long = `+${"x".repeat(200)}`;
    const text = formatReviewBlock(block({ quote: [long], start: 1, end: 1, note: "n" }));
    const quoted = text.split("\n")[2]!;
    expect(quoted).toHaveLength(161);
    expect(quoted.endsWith("…")).toBe(true);
    expect(cutQuoteLine(cutQuoteLine(long))).toBe(cutQuoteLine(long));
    expect(blockHash([long])).not.toBe(blockHash([cutQuoteLine(long)]));
  });

  it("quotes empty note lines as a bare >", () => {
    const text = formatReviewBlock(block({ note: "one\n\ntwo" }));
    expect(text.split("\n").slice(-3)).toEqual(["> one", ">", "> two"]);
  });
});

describe("parseReviewBlocks round trip", () => {
  const cases: [string, Partial<ReviewBlock>][] = [
    ["one line", { start: 3, end: 3, quote: [" x"], note: "n" }],
    ["a range", {}],
    ["the old side", { side: "old", quote: ["-a", "-b", " c"], start: 4, end: 6 }],
    ["both outdated and old", { side: "old", outdated: true, quote: ["-a"], start: 1, end: 1 }],
    ["a backtick fence in the quote", { quote: ["+```ts", "+x", "+```"], start: 1, end: 3 }],
    ["notes with blank lines and > text", { note: "first\n\n> quoted > text\n>\n  indented" }],
    ["tabs", { quote: ["+\tindented", " \tmore"], note: "tab\tin note" }],
    ["unicode", { quote: ["+const café = '日本語 🙂';"], start: 1, end: 1, note: "naïve — ok ✓" }],
    ["a 200-character line (cut)", { quote: [`+${"y".repeat(200)}`], start: 1, end: 1 }],
    ["an empty context line", { quote: ["+a", " ", "+b"], start: 1, end: 3 }],
    ["a path with a space and a colon-digit", { path: "docs/my notes:2/a b.md" }],
  ];
  for (const [name, over] of cases) {
    it(`returns path, range, side, quote and note exactly: ${name}`, () => {
      const b = block(over);
      const parsed = only(formatReviewBlock(b));
      expect(parsed).toEqual({ ...b, quote: b.quote.map(cutQuoteLine) });
    });
  }

  it("tolerates \\r\\n", () => {
    const text = formatReviewBlock(block()).replace(/\n/g, "\r\n");
    expect(only(text)).toEqual(block());
  });

  it("keeps the user's text around blocks", () => {
    const a = formatReviewBlock(block({ note: "A" }));
    const b = formatReviewBlock(block({ path: "b.ts", note: "B" }));
    const segments = parseReviewBlocks(`please look\n\n${a}\n\nthen this\n\n${b}\n\nthanks`);
    expect(segments.map((s) => s.type)).toEqual(["text", "review", "text", "review", "text"]);
    expect(segments.filter((s) => s.type === "text").map((s) => (s as { text: string }).text)).toEqual(["please look\n", "\nthen this\n", "\nthanks"]);
    expect(segments[1]).toMatchObject({ raw: a });
  });

  it("leaves a header with no fence, an unclosed fence, or no note as the user's own text", () => {
    const header = "[review] a.ts:1 (new)";
    for (const text of [header, `${header}\nnot a fence\n> note`, `${header}\n\`\`\`diff\n+x\n> note`, `${header}\n\`\`\`diff\n+x\n\`\`\`\nno quote marker`, `${header}\n\`\`\`diff\n\`\`\`\n> empty quote`]) {
      expect(reviewBlocksIn(text), text).toHaveLength(0);
    }
  });

  it("leaves a non-matching header as the user's text", () => {
    for (const header of ["[review] a.ts (new)", "[review] a.ts:1 (both)", "review a.ts:1 (new)", " [review] a.ts:1 (new)", "[review] a.ts:5-2 (new)"]) {
      expect(reviewBlocksIn(`${header}\n\`\`\`diff\n+x\n\`\`\`\n> n`), header).toHaveLength(0);
    }
  });

  it("does not take a quoted line that is not a diff line", () => {
    expect(reviewBlocksIn("[review] a.ts:1 (new)\n```diff\nplain\n```\n> n")).toHaveLength(0);
  });
});

describe("matching a block to a comment", () => {
  it("keys on path, side, quote and note, not the range or the outdated flag", () => {
    const b = block();
    expect(blockKey({ ...b, quote: b.quote })).toBe(blockKey(only(formatReviewBlock({ ...b, start: 90, end: 92, outdated: true }))));
    expect(blockKey(b)).not.toBe(blockKey(block({ note: "other" })));
  });

  it("isInMessage finds the block anywhere in a draft", () => {
    const b = block();
    expect(isInMessage(b, "")).toBe(false);
    expect(isInMessage(b, `hello\n\n${formatReviewBlock(b)}\n\nbye`)).toBe(true);
    expect(isInMessage(b, "mentions [review] but is not a block")).toBe(false);
  });
});

describe("limits and Add all", () => {
  const nth = (i: number) => formatReviewBlock(block({ path: `f${i}.ts`, note: `n${i}` }));

  it("appends after a blank line, or alone into an empty draft", () => {
    const one = nth(1);
    expect(appendReviewBlocks("", [one])).toEqual({ text: one, added: 1 });
    expect(appendReviewBlocks("my words", [one]).text).toBe(`my words\n\n${one}`);
    expect(appendReviewBlocks("my words\n\n", [one]).text).toBe(`my words\n\n${one}`);
    expect(appendReviewBlocks("  \n", [one]).text).toBe(one);
  });

  it("stops at 10 comments a message, counting blocks already typed or pasted", () => {
    const blocks = Array.from({ length: 12 }, (_, i) => nth(i));
    const first = appendReviewBlocks("", blocks);
    expect(first.added).toBe(MAX_COMMENTS_PER_MESSAGE);
    expect(reviewUsage(first.text).count).toBe(10);
    expect(appendReviewBlocks(first.text, [nth(99)]).added).toBe(0);
    const six = appendReviewBlocks("", blocks.slice(0, 6));
    expect(appendReviewBlocks(six.text, blocks.slice(6, 12)).added).toBe(4);
  });

  it("stops before 12,000 characters of blocks", () => {
    const fat = (i: number) => formatReviewBlock(block({ path: `f${i}.ts`, quote: Array.from({ length: 12 }, () => `+${"z".repeat(160)}`), start: 1, end: 12, note: "n".repeat(900) }));
    const blocks = Array.from({ length: 6 }, (_, i) => fat(i));
    const { text, added } = appendReviewBlocks("", blocks);
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(6);
    expect(reviewUsage(text).chars).toBeLessThanOrEqual(MAX_BLOCK_CHARS_PER_MESSAGE);
  });
});
