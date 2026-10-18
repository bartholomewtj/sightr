// T29: the Files refusal list, as a comment sees it. The first table is bridge/workdir.test.ts's.
import { describe, expect, it } from "vitest";

import { commentPathProblem, isRefusedName } from "./refusedPaths";

describe("isRefusedName (a copy of bridge/workdir.ts)", () => {
  it("refuses the names the bridge refuses", () => {
    for (const n of [".env", ".git", "node_modules", "config", "server.pem", "id_rsa", "__pycache__", "adws"]) expect(isRefusedName(n), n).toBe(true);
    for (const n of ["secret.key", "cert.PFX", "vault.kdbx", "id_ed25519.pub", "Thumbs.db", "desktop.ini", "venv", "target", "vendor", ".github"]) expect(isRefusedName(n), n).toBe(true);
  });
  it("lets an ordinary name through", () => {
    for (const n of ["a.ts", "README.md", "keyboard.ts", "identity.md", "configure.ts", "src", "monkey.ts"]) expect(isRefusedName(n), n).toBe(false);
  });
});

describe("commentPathProblem", () => {
  it("accepts a repo-relative forward-slash path", () => {
    expect(commentPathProblem("src/lib/foo.ts")).toBeNull();
    expect(commentPathProblem("a.ts")).toBeNull();
    expect(commentPathProblem("docs/my notes/a b.md")).toBeNull();
  });

  it("refuses a path with a refused segment anywhere", () => {
    for (const p of [".env", "src/.env", "a/node_modules/x/index.js", "keys/server.pem", "ssh/id_rsa", "config/app.toml", ".github/workflows/ci.yml"]) {
      expect(commentPathProblem(p), p).toBe("refused");
    }
  });

  it("refuses a journal-style absolute path, a drive letter, .., a backslash, and empty or control segments", () => {
    const tooLong = "d/".repeat(600) + "x";
    for (const p of ["/etc/passwd", "/home/me/src/a.ts", "C:/Users/me/a.ts", "C:\\Users\\me\\a.ts", "src\\a.ts", "../a.ts", "a/../b.ts", "a//b.ts", "./a.ts", "a/./b.ts", "", "a\u0000b.ts", "a\nb.ts", tooLong, "a/b:c.ts", "src/file:stream", "x/".repeat(32) + "y"]) {
      expect(commentPathProblem(p), JSON.stringify(p)).toBe("unsafe");
    }
  });
});
