import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TranscriptImage, TranscriptPart } from "../../shared/wire.ts";
import { parseClaudeTranscript } from "./claude.ts";
import { base64Bytes, logLines, rowImages, toolImageName } from "./images.ts";
import { parsePiTranscript } from "./pi.ts";

// Synthetic fixtures with the JSON structure of real Claude Code 2.1.30x and pi rows that carry
// images (a Read of a PNG, a chrome screenshot, a paste, a pi read). The image is a 1x1 PNG.
const raw = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name));
const PNG_BYTES = 70;

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type TextPart = Extract<TranscriptPart, { kind: "text" }>;

/** The row an image reference points at, read straight off the fixture bytes. */
function rowAt(bytes: Buffer, image: TranscriptImage): Record<string, unknown> {
  expect(image.at).toBeNumber();
  const at = image.at!;
  if (at > 0) expect(bytes[at - 1]).toBe(0x0a);
  const end = bytes.indexOf(0x0a, at);
  return JSON.parse(bytes.subarray(at, end === -1 ? undefined : end).toString("utf8")) as Record<string, unknown>;
}

describe("rowImages", () => {
  test("Claude: top-level images and tool_result images, in content order", () => {
    const row = {
      message: {
        content: [
          { type: "tool_result", content: [{ type: "text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
          { type: "image", source: { type: "url", url: "https://example.invalid/a.png" } },
        ],
      },
    };
    expect(rowImages(row)).toEqual([
      { mimeType: "image/png", data: "AAAA" },
      { mimeType: "image/jpeg", data: "BBBB" },
    ]);
  });

  test("pi: image blocks carry data and mimeType", () => {
    expect(rowImages({ message: { content: [{ type: "text", text: "a" }, { type: "image", data: "CCCC", mimeType: "image/webp" }] } })).toEqual([
      { mimeType: "image/webp", data: "CCCC" },
    ]);
  });

  test("anything else has none", () => {
    expect(rowImages(null)).toEqual([]);
    expect(rowImages({ message: { content: "a string" } })).toEqual([]);
    expect(rowImages({ message: { content: [{ type: "text", text: "a" }] } })).toEqual([]);
  });
});

describe("helpers", () => {
  test("base64Bytes counts padding out", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
  });

  test("logLines gives each line's byte offset, multi-byte characters included", () => {
    const text = "é1\nabc\n✓\n";
    expect(logLines(text, 10)).toEqual([
      { line: "é1", at: 10 },
      { line: "abc", at: 14 },
      { line: "✓", at: 18 },
      { line: "", at: 22 },
    ]);
    expect(logLines("a\nb", undefined).map((l) => l.at)).toEqual([undefined, undefined]);
  });

  test("toolImageName: the file read, else Image, numbered when several", () => {
    expect(toolImageName({ file_path: "C:\\demo\\logo.png" }, 0, 1)).toBe("logo.png");
    expect(toolImageName({ path: "/tmp/a/b.jpg" }, 1, 2)).toBe("b.jpg (2)");
    expect(toolImageName({ action: "screenshot" }, 0, 1)).toBe("Image");
    expect(toolImageName(undefined, 2, 3)).toBe("Image (3)");
  });
});

describe("Claude fixture: images as references", () => {
  const bytes = raw("claude-images.jsonl");
  const entries = parseClaudeTranscript(bytes.toString("utf8"), { byteOffset: 0 });
  const tools = entries.flatMap((e) => e.parts).filter((p): p is ToolPart => p.kind === "tool");

  test("a Read of a PNG keeps its image on the call, named by the file", () => {
    const read = tools.find((t) => t.name === "Read")!;
    expect(read.result?.text).toBe("");
    expect(read.images).toHaveLength(1);
    const image = read.images![0]!;
    expect(image).toMatchObject({ mimeType: "image/png", sizeBytes: PNG_BYTES, name: "logo.png", n: 0, row: "c1000000-0000-4000-8000-000000000003" });
    expect(rowAt(bytes, image).uuid).toBe(image.row);
  });

  test("a screenshot after two text blocks is the result's image; the text stays the output", () => {
    const shot = tools.find((t) => t.name === "mcp__claude-in-chrome__computer")!;
    expect(shot.result?.text).toBe("Successfully captured screenshot\nTab Context: demo");
    expect(shot.images).toEqual([expect.objectContaining({ name: "Image", n: 0, mimeType: "image/jpeg" })]);
    expect(rowImages(rowAt(bytes, shot.images![0]!))).toHaveLength(1);
  });

  test("a paste goes with its words; a lone image is a message of its own", () => {
    const users = entries.filter((e) => e.role === "user");
    const pasted = users.find((e) => (e.parts[0] as TextPart).text === "[Image #1] what is this?")!;
    expect((pasted.parts[0] as TextPart).images).toEqual([expect.objectContaining({ name: "Pasted image 1", n: 0 })]);
    const lone = users.find((e) => (e.parts[0] as TextPart).text === "")!;
    expect((lone.parts[0] as TextPart).images).toHaveLength(1);
    expect(rowAt(bytes, (lone.parts[0] as TextPart).images![0]!).uuid).toBe(lone.uuid);
  });

  test("offsets are absolute: a parse of a later slice points at the same rows", () => {
    const cut = bytes.indexOf(0x0a) + 1;
    const later = parseClaudeTranscript(bytes.subarray(cut).toString("utf8"), { byteOffset: cut });
    const a = tools.find((t) => t.name === "Read")!.images![0]!.at;
    const b = later.flatMap((e) => e.parts).find((p): p is ToolPart => p.kind === "tool" && p.name === "Read")!.images![0]!.at;
    expect(b).toBe(a!);
  });

  test("without an offset the images keep no `at` (v1 history), and no bytes ever", () => {
    const v1 = parseClaudeTranscript(bytes.toString("utf8"));
    const images = v1.flatMap((e) => e.parts).flatMap((p) => (p.kind === "tool" || p.kind === "text" ? (p.images ?? []) : []));
    expect(images).toHaveLength(4);
    expect(images.every((i) => i.at === undefined)).toBe(true);
    expect(JSON.stringify(v1)).not.toContain("iVBORw0KGgo");
  });
});

describe("pi fixture: images as references", () => {
  const bytes = raw("pi-images.jsonl");
  const entries = parsePiTranscript(bytes.toString("utf8"), { byteOffset: 0 });

  test("a user's image goes with the words", () => {
    const user = entries.find((e) => e.role === "user")!;
    const words = user.parts[0] as TextPart;
    expect(words.text).toBe("What is in this picture?");
    expect(words.images).toEqual([expect.objectContaining({ name: "Pasted image 1", n: 0, row: "p1000001", mimeType: "image/png" })]);
    expect(rowAt(bytes, words.images![0]!).id).toBe("p1000001");
  });

  test("a read of an image lands on the call", () => {
    const read = entries.flatMap((e) => e.parts).find((p): p is ToolPart => p.kind === "tool" && p.name === "read")!;
    expect(read.result?.text).toBe("Read image file [image/png]");
    expect(read.images).toEqual([expect.objectContaining({ name: "logo.png", n: 0, row: "p1000003", sizeBytes: PNG_BYTES })]);
    expect(rowAt(bytes, read.images![0]!).id).toBe("p1000003");
    expect(JSON.stringify(entries)).not.toContain("iVBORw0KGgo");
  });
});
