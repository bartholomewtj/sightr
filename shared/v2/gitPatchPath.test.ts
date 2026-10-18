// T3 Code's gitPatchPath.test.ts @ 3a4d118a5 (MIT, see web2/THIRD_PARTY.md), run under bun:test instead of
// vite-plus, plus the cases for gitPatchSidePath (Sightr's addition).
// web and web2 typecheck ../shared too, and only the root project has bun's types; this suite runs under `bun test ./shared`.
// @ts-ignore TS2307 outside the root project
import { describe, expect, test } from "bun:test";
import { gitPatchSidePath, quoteGitPatchPath, unquoteGitPatchPath } from "./gitPatchPath.ts";

const BELL = "\u0007";
const UNIT_SEPARATOR = "\u001f";
const DELETE = "\u007f";

describe("quoteGitPatchPath", () => {
  test("leaves a name a header can carry as itself", () => {
    expect(quoteGitPatchPath("src/app.ts")).toBe("src/app.ts");
    expect(quoteGitPatchPath("with space.txt")).toBe("with space.txt");
    expect(quoteGitPatchPath("café/résumé.ts")).toBe("café/résumé.ts");
    expect(quoteGitPatchPath("🚀.ts")).toBe("🚀.ts");
  });

  test("writes git's escape for a character the header would read as its own", () => {
    expect(quoteGitPatchPath("tab\tfile.txt")).toBe('"tab\\tfile.txt"');
    expect(quoteGitPatchPath("line\nfile.txt")).toBe('"line\\nfile.txt"');
    expect(quoteGitPatchPath('quo"te.txt')).toBe('"quo\\"te.txt"');
    expect(quoteGitPatchPath("back\\slash.txt")).toBe('"back\\\\slash.txt"');
    expect(quoteGitPatchPath(`ring${BELL}.txt`)).toBe('"ring\\a.txt"');
  });

  test("writes the octal of a control character git has no name for", () => {
    expect(quoteGitPatchPath(`unit${UNIT_SEPARATOR}.txt`)).toBe('"unit\\037.txt"');
    expect(quoteGitPatchPath(`del${DELETE}.txt`)).toBe('"del\\177.txt"');
  });
});

describe("a name written into a header and read back out", () => {
  const names = [
    "src/app.ts", "with space.txt", "café/résumé.ts", "🚀.ts", "tab\tfile.txt", "line\nfile.txt", "carriage\rfile.txt",
    'quo"te.txt', "back\\slash.txt", `ring${BELL}.txt`, `unit${UNIT_SEPARATOR}.txt`, `del${DELETE}.txt`, `every\t\n\r"\\${BELL}.txt`,
  ];

  test.each(names)("is the name that went in: %j", (name: string) => {
    const written = quoteGitPatchPath(name);
    expect(unquoteGitPatchPath(written)).toBe(name);
    const unwrapped = written.startsWith('"') ? written.slice(1, -1) : written;
    expect(unquoteGitPatchPath(unwrapped)).toBe(name);
  });

  test("carries the whole name past the first thing a header stops at", () => {
    const written = quoteGitPatchPath("tab\tfile.txt");
    expect(written).not.toContain("\t");
    expect(written).not.toContain("\n");
    expect(unquoteGitPatchPath(written)).not.toBe("tab");
  });
});

describe("unquoteGitPatchPath", () => {
  test("leaves a token git saw no need to quote alone", () => {
    expect(unquoteGitPatchPath("src/app.ts")).toBe("src/app.ts");
    expect(unquoteGitPatchPath("with space.txt")).toBe("with space.txt");
    expect(unquoteGitPatchPath("")).toBe("");
    expect(unquoteGitPatchPath('"')).toBe('"');
  });

  test("reads the octal escapes a host with core.quotePath on writes", () => {
    expect(unquoteGitPatchPath('"caf\\303\\251/r\\303\\251sum\\303\\251.ts"')).toBe("café/résumé.ts");
    expect(unquoteGitPatchPath('"\\360\\237\\232\\200.ts"')).toBe("🚀.ts");
  });
});

describe("a name a parser handed back with its quotes already off", () => {
  test("is read for the escapes it still carries", () => {
    expect(unquoteGitPatchPath("tab\\tfile.txt")).toBe("tab\tfile.txt");
    expect(unquoteGitPatchPath("caf\\303\\251.ts")).toBe("café.ts");
  });

  test("reads an escape git would never write the way C reads it", () => {
    expect(unquoteGitPatchPath("odd\\zname.txt")).toBe("oddzname.txt");
    expect(unquoteGitPatchPath("trailing\\")).toBe("trailing\\");
    expect(unquoteGitPatchPath("short\\12.txt")).toBe("short12.txt");
  });
});

describe("gitPatchSidePath", () => {
  test("strips the a/ and b/ side prefix", () => {
    expect(gitPatchSidePath("a/src/app.ts")).toBe("src/app.ts");
    expect(gitPatchSidePath("b/src/app.ts")).toBe("src/app.ts");
    expect(gitPatchSidePath("src/app.ts")).toBe("src/app.ts");
  });
  test("reads octal UTF-8, \\\", \\\\ and \\t inside the quotes, then strips the side", () => {
    expect(gitPatchSidePath('"a/caf\\303\\251.txt"')).toBe("café.txt");
    expect(gitPatchSidePath('"b/quo\\"te.txt"')).toBe('quo"te.txt');
    expect(gitPatchSidePath('"b/back\\\\slash.txt"')).toBe("back\\slash.txt");
    expect(gitPatchSidePath('"a/tab\\tfile.txt"')).toBe("tab\tfile.txt");
  });
  test("/dev/null is the absent side", () => {
    expect(gitPatchSidePath("/dev/null")).toBeNull();
  });
  test("a raw tab ends the name (git adds one after a name that holds spaces)", () => {
    expect(gitPatchSidePath("b/with space.txt\t")).toBe("with space.txt");
  });
});
