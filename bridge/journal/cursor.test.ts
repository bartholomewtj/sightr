import { describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CursorTranscriptSource,
  displayUserText,
  isCursorSessionId,
  parseCursorTranscript,
} from "./cursor.ts";

const row = (role: "user" | "assistant", content: unknown, id?: string) =>
  JSON.stringify({
    role,
    ...(id ? { id } : {}),
    message: { content },
  });

describe("isCursorSessionId", () => {
  test.each([
    ["a v4 uuid", "489a825c-14f8-45c6-af97-69dfe4529a8f", true],
    ["a traversal attempt", "../../secrets", false],
    ["empty", "", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isCursorSessionId(value)).toBe(expected);
  });
});

describe("displayUserText", () => {
  test("unwraps user_query and drops the timestamp envelope", () => {
    expect(
      displayUserText(
        "<timestamp>Saturday, Sep 12, 2026, 6:55 AM (UTC+10)</timestamp>\n<user_query>\ncheck my billing\n</user_query>",
      ),
    ).toBe("check my billing");
  });

  test("passes through plain speech", () => {
    expect(displayUserText("just a question")).toBe("just a question");
  });
});

describe("parseCursorTranscript", () => {
  test("reads speech turns and tool_use blocks", () => {
    const entries = parseCursorTranscript(
      [
        row("user", [{ type: "text", text: "<user_query>\ngo\n</user_query>" }], "u1"),
        row(
          "assistant",
          [
            { type: "text", text: "on it" },
            { type: "tool_use", name: "Shell", input: { command: "ls" } },
          ],
          "a1",
        ),
      ].join("\n"),
    );
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["u1", "user"],
      ["a1", "assistant"],
    ]);
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "go" }]);
    expect(entries[1]!.parts[0]).toEqual({ kind: "text", text: "on it" });
    expect(entries[1]!.parts[1]).toMatchObject({ kind: "tool", name: "Shell" });
  });

  test("skips system / unknown roles and bad lines", () => {
    const text = [
      JSON.stringify({ role: "system", message: { content: "ignore" } }),
      "not-json",
      row("user", [{ type: "text", text: "hi" }], "u"),
    ].join("\n");
    expect(parseCursorTranscript(text).map((e) => e.uuid)).toEqual(["u"]);
  });

  test("synthesises uuids when rows omit id", () => {
    const entries = parseCursorTranscript(row("user", "hello"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.uuid).toBe("cursor-0");
    expect(entries[0]!.parts).toEqual([{ kind: "text", text: "hello" }]);
  });
});

describe("CursorTranscriptSource", () => {
  test("resolves id under projects/<slug>/agent-transcripts/<id>/<id>.jsonl", async () => {
    const root = join(tmpdir(), `sightr-cursor-journal-${Date.now()}`);
    const id = "489a825c-14f8-45c6-af97-69dfe4529a8f";
    const dir = join(root, "C-work-dir", "agent-transcripts", id);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    await writeFile(file, row("user", [{ type: "text", text: "hi" }]) + "\n");

    try {
      const source = new CursorTranscriptSource(root);
      expect(await source.resolve({ kind: "id", value: id })).toBe(file);
      expect(await source.resolve({ kind: "id", value: "not-a-uuid" })).toBeNull();
      expect(await source.resolve({ kind: "path", value: file })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
