// T3 Code apps/web/src/components/diffs/commentSubmitShortcut.test.ts @ 3a4d118a518a (MIT, see THIRD_PARTY.md):
// the two cases are T3's; the import is vitest's (T3 runs vite-plus), and the cases after them pin the key rule
// Sightr relies on (Mod+Enter only; a plain Enter, Shift+Enter and Alt+Enter add a line).
import { describe, expect, it } from "vitest";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

describe("isCommentSubmitShortcut", () => {
  it("accepts Command or Ctrl+Enter only while an eligible comment is idle", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "Looks good", false),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true }, "Looks good", false),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "Looks good", true),
    ).toBe(false);
  });

  it("rejects empty comments and unrelated key presses", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "   ", false),
    ).toBe(false);
    expect(
      isCommentSubmitShortcut({ key: "K", metaKey: true, ctrlKey: false }, "Looks good", false),
    ).toBe(false);
  });

  it("leaves a plain Enter to add a line", () => {
    expect(isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false }, "Looks good", false)).toBe(false);
  });
});
