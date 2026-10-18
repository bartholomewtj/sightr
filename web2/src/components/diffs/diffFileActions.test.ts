// diffFileActions.ts is Sightr's own (T3 Code has no such file; see its header), so these are Sightr's cases.
import { describe, expect, it } from "vitest";

import { canOpenInFiles, editsLabel, fileLabel, filesPathOf, KIND_CHIP } from "./diffFileActions";

describe("diffFileActions", () => {
  it("gives every kind of change a letter and a word", () => {
    expect(Object.entries(KIND_CHIP).map(([k, v]) => `${k}:${v.letter}:${v.word}`)).toEqual(["added:A:added", "modified:M:modified", "deleted:D:deleted", "renamed:R:renamed", "untracked:?:untracked"]);
  });

  it("opens in Files unless the file is gone", () => {
    expect(canOpenInFiles({ kind: "modified" })).toBe(true);
    expect(canOpenInFiles({ kind: "untracked" })).toBe(true);
    expect(canOpenInFiles({ kind: "deleted" })).toBe(false);
  });

  it("maps a repo path to a Files path under the repo root", () => {
    expect(filesPathOf("proj", "src/a.ts")).toBe("proj/src/a.ts");
    expect(filesPathOf("", "src/a.ts")).toBe("src/a.ts");
  });

  it("names a rename with both paths", () => {
    expect(fileLabel({ path: "src/new.ts", oldPath: "src/old.ts" })).toBe("src/old.ts → src/new.ts");
    expect(fileLabel({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(fileLabel({ path: "src/a.ts", oldPath: "src/a.ts" })).toBe("src/a.ts");
  });

  it("counts edits only past the first", () => {
    expect(editsLabel(3)).toBe("3 edits");
    expect(editsLabel(1)).toBe("");
    expect(editsLabel(undefined)).toBe("");
  });
});
