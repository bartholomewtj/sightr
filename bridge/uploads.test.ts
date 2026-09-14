import { describe, expect, test } from "bun:test";

import {
  filesToEvict,
  filesToPrune,
  extFromName,
  imageExtFromBytes,
  looksLikeText,
  makeRoomForUpload,
  MAX_UPLOADS_TOTAL_BYTES,
  SNIFF_BYTES,
  sweepUploads,
  type UploadFs,
  uploadExt,
} from "./uploads.ts";

// filesToPrune and filesToEvict are pure decisions; sweepUploads and makeRoomForUpload are exercised
// with fake fs implementations so the stat/unlink orchestration (and error handling) is covered
// without touching disk.

const HOUR = 60 * 60 * 1000;
const TTL = 48 * HOUR;

// The upload allow-list used to be a bare-object lookup on the client-declared Content-Type, so
// "__proto__" and "constructor" resolved to truthy Object.prototype members and sailed through
// (issue #9). The extension now comes from the bytes, so these tests pin the whole check.
describe("imageExtFromBytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);

  test("recognises each accepted format", () => {
    expect(imageExtFromBytes(png)).toBe("png");
    expect(imageExtFromBytes(jpg)).toBe("jpg");
    expect(imageExtFromBytes(gif)).toBe("gif");
    expect(imageExtFromBytes(webp)).toBe("webp");
  });

  test("a RIFF container that is not WebP is refused", () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(imageExtFromBytes(wav)).toBeNull();
  });

  // The exact bypass from issue #9: these strings were the client's declared Content-Type, and each
  // one resolved to a truthy Object.prototype member. As BYTES they are just text, like any other
  // non-image payload — which is the point.
  test.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "%s is not an image type",
    (name) => {
      expect(imageExtFromBytes(new TextEncoder().encode(name))).toBeNull();
    },
  );

  test("script content declared as an image is refused", () => {
    expect(imageExtFromBytes(new TextEncoder().encode("#!/bin/sh\necho hi"))).toBeNull();
  });

  test("a buffer shorter than a signature matches nothing", () => {
    expect(imageExtFromBytes(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(imageExtFromBytes(new Uint8Array())).toBeNull();
  });

  test("SNIFF_BYTES is enough for every signature", () => {
    expect(imageExtFromBytes(webp.subarray(0, SNIFF_BYTES))).toBe("webp");
  });
});

// A text attachment is judged by its NAME (which format it claims) with its BYTES holding a veto
// (is it text at all). Both halves are pinned here, plus the boundary the saved filename is built
// from — the extension reaches a path, so anything that is not plain alphanumerics is refused.
describe("extFromName", () => {
  test("takes the last dot, lowercased", () => {
    expect(extFromName("notes.MD")).toBe("md");
    expect(extFromName("archive.tar.gz")).toBe("gz");
  });

  test("refuses a name that claims no extension", () => {
    expect(extFromName("README")).toBeNull();
    expect(extFromName(".gitignore")).toBeNull(); // a leading dot is a name, not an extension
    expect(extFromName("trailing.")).toBeNull();
  });

  test("refuses anything but plain alphanumerics — the extension reaches a path", () => {
    expect(extFromName("evil.md/../../etc/passwd")).toBeNull();
    expect(extFromName("weird.m d")).toBeNull();
  });
});

describe("looksLikeText", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  test("accepts text, including tabs, newlines and ANSI escapes in a log", () => {
    expect(looksLikeText(bytes("# Title\n\tindented\r\n"))).toBe(true);
    expect(looksLikeText(bytes("\u001b[31mred\u001b[0m"))).toBe(true);
    expect(looksLikeText(new Uint8Array([]))).toBe(true); // an empty file disagrees with nothing
  });

  test("refuses a binary wearing a text name", () => {
    expect(looksLikeText(new Uint8Array([0x00, 0x01, 0x02]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0x7f]))).toBe(false);
  });
});

describe("uploadExt — the whole accept decision", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const bytes = (s: string) => new TextEncoder().encode(s);

  test("bytes decide an image, whatever the file is called", () => {
    expect(uploadExt("screenshot.txt", png)).toBe("png");
    expect(uploadExt("no-extension-at-all", png)).toBe("png");
  });

  test("takes a text file its name claims and its bytes agree with", () => {
    expect(uploadExt("plan.md", bytes("# Plan\n- one"))).toBe("md");
    expect(uploadExt("run.PY", bytes("print('hi')"))).toBe("py");
    expect(uploadExt("data.jsonl", bytes('{"a":1}'))).toBe("jsonl");
  });

  test("refuses a format the list does not name, and a binary that claims one", () => {
    expect(uploadExt("archive.zip", bytes("PK stuff"))).toBeNull();
    expect(uploadExt("payload.md", new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    expect(uploadExt("README", bytes("no extension"))).toBeNull();
  });
});

describe("filesToPrune", () => {
  const now = 1_000_000_000_000;

  test("prunes only entries strictly older than the TTL", () => {
    const entries = [
      { name: "fresh.png", mtimeMs: now - 1 * HOUR },
      { name: "old.png", mtimeMs: now - 49 * HOUR },
      { name: "ancient.jpg", mtimeMs: now - 100 * HOUR },
    ];
    expect(filesToPrune(entries, now, TTL)).toEqual(["old.png", "ancient.jpg"]);
  });

  test("an entry exactly at the TTL boundary is kept (not strictly older)", () => {
    expect(filesToPrune([{ name: "edge.png", mtimeMs: now - TTL }], now, TTL)).toEqual([]);
  });

  test("empty input yields nothing", () => {
    expect(filesToPrune([], now, TTL)).toEqual([]);
  });
});

describe("filesToEvict", () => {
  const cap = 1000;

  test("under the cap evicts nothing", () => {
    const entries = [
      { name: "a.png", mtimeMs: 100, size: 200 },
      { name: "b.png", mtimeMs: 200, size: 300 },
    ];
    expect(filesToEvict(entries, 400, cap)).toEqual([]);
  });

  test("total exactly equal to the cap does not evict", () => {
    const entries = [
      { name: "a.png", mtimeMs: 100, size: 500 },
    ];
    expect(filesToEvict(entries, 500, cap)).toEqual([]);
  });

  test("evicts oldest first and stops as soon as incoming fits", () => {
    const entries = [
      { name: "middle.png", mtimeMs: 200, size: 300 },
      { name: "oldest.png", mtimeMs: 100, size: 300 },
      { name: "newest.png", mtimeMs: 300, size: 300 },
    ];
    // Total existing = 900. Incoming = 200. Total = 1100 > 1000.
    // Evicting oldest (300) leaves 600 + 200 = 800 <= 1000. Stops after oldest.
    expect(filesToEvict(entries, 200, cap)).toEqual(["oldest.png"]);
  });

  test("evicts multiple files in oldest-first order if needed", () => {
    const entries = [
      { name: "c.png", mtimeMs: 300, size: 300 },
      { name: "a.png", mtimeMs: 100, size: 300 },
      { name: "b.png", mtimeMs: 200, size: 300 },
    ];
    // Total existing = 900. Incoming = 500. Total = 1400 > 1000.
    // Evict a (300): total = 1100 > 1000.
    // Evict b (300): total = 800 <= 1000. Stops.
    expect(filesToEvict(entries, 500, cap)).toEqual(["a.png", "b.png"]);
  });

  test("an incoming file larger than the whole cap evicts all existing files", () => {
    const entries = [
      { name: "a.png", mtimeMs: 100, size: 200 },
      { name: "b.png", mtimeMs: 200, size: 200 },
    ];
    expect(filesToEvict(entries, 1200, cap)).toEqual(["a.png", "b.png"]);
  });

  test("empty directory evicts nothing", () => {
    expect(filesToEvict([], 500, cap)).toEqual([]);
  });
});

describe("sweepUploads", () => {
  function fakeFs(
    files: Record<string, number>,
    opts: { failStat?: Set<string>; failUnlink?: Set<string> } = {},
  ): { fs: UploadFs; unlinked: string[] } {
    const unlinked: string[] = [];
    const fs: UploadFs = {
      readdir: () => Promise.resolve(Object.keys(files)),
      stat: (p) => {
        const name = p.split(/[\\/]/).pop()!;
        if (opts.failStat?.has(name)) return Promise.reject(new Error("stat gone"));
        return Promise.resolve({ mtimeMs: files[name]!, size: 0 });
      },
      unlink: (p) => {
        const name = p.split(/[\\/]/).pop()!;
        if (opts.failUnlink?.has(name)) return Promise.reject(new Error("unlink gone"));
        unlinked.push(name);
        return Promise.resolve();
      },
    };
    return { fs, unlinked };
  }

  const now = 1_000_000_000_000;

  test("removes expired files and returns their names", async () => {
    const { fs, unlinked } = fakeFs({
      "fresh.png": now - 1 * HOUR,
      "old.png": now - 72 * HOUR,
    });
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a missing uploads dir is not an error (nothing uploaded yet)", async () => {
    const fs: UploadFs = {
      readdir: () => Promise.reject(new Error("ENOENT")),
      stat: () => Promise.reject(new Error("nope")),
      unlink: () => Promise.reject(new Error("nope")),
    };
    expect(await sweepUploads("/uploads", TTL, now, fs)).toEqual([]);
  });

  test("skips a file that vanishes between readdir and stat", async () => {
    const { fs, unlinked } = fakeFs(
      { "old.png": now - 72 * HOUR, "racy.png": now - 72 * HOUR },
      { failStat: new Set(["racy.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["old.png"]);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a failed unlink is skipped without aborting the sweep", async () => {
    const { fs, unlinked } = fakeFs(
      { "a.png": now - 72 * HOUR, "b.png": now - 72 * HOUR },
      { failUnlink: new Set(["a.png"]) },
    );
    const removed = await sweepUploads("/uploads", TTL, now, fs);
    expect(removed).toEqual(["b.png"]);
    expect(unlinked).toEqual(["b.png"]);
  });
});

describe("makeRoomForUpload", () => {
  function fakeCapFs(
    files: Record<string, { mtimeMs: number; size: number }>,
    opts: { failStat?: Set<string>; failUnlink?: Set<string>; failReaddir?: boolean } = {},
  ): { fs: UploadFs; unlinked: string[] } {
    const unlinked: string[] = [];
    const fs: UploadFs = {
      readdir: () =>
        opts.failReaddir ? Promise.reject(new Error("ENOENT")) : Promise.resolve(Object.keys(files)),
      stat: (p) => {
        const name = p.split(/[\\/]/).pop()!;
        if (opts.failStat?.has(name)) return Promise.reject(new Error("stat gone"));
        const entry = files[name];
        if (!entry) return Promise.reject(new Error("not found"));
        return Promise.resolve(entry);
      },
      unlink: (p) => {
        const name = p.split(/[\\/]/).pop()!;
        if (opts.failUnlink?.has(name)) return Promise.reject(new Error("unlink gone"));
        unlinked.push(name);
        return Promise.resolve();
      },
    };
    return { fs, unlinked };
  }

  const cap = 1000;

  test("fits without eviction (nothing unlinked, returns true)", async () => {
    const { fs, unlinked } = fakeCapFs({
      "a.png": { mtimeMs: 100, size: 200 },
      "b.png": { mtimeMs: 200, size: 300 },
    });
    const ok = await makeRoomForUpload("/uploads", 400, cap, fs);
    expect(ok).toBe(true);
    expect(unlinked).toEqual([]);
  });

  test("evicts the oldest and returns true", async () => {
    const { fs, unlinked } = fakeCapFs({
      "old.png": { mtimeMs: 100, size: 400 },
      "new.png": { mtimeMs: 200, size: 400 },
    });
    // Existing = 800, incoming = 300, total = 1100 > 1000. Evict old.png (400) -> 700 <= 1000.
    const ok = await makeRoomForUpload("/uploads", 300, cap, fs);
    expect(ok).toBe(true);
    expect(unlinked).toEqual(["old.png"]);
  });

  test("a missing dir returns true (nothing stored yet)", async () => {
    const { fs } = fakeCapFs({}, { failReaddir: true });
    const ok = await makeRoomForUpload("/uploads", 500, cap, fs);
    expect(ok).toBe(true);
  });

  test("every unlink failing returns false when space cannot be freed", async () => {
    const { fs, unlinked } = fakeCapFs(
      {
        "old.png": { mtimeMs: 100, size: 600 },
        "new.png": { mtimeMs: 200, size: 300 },
      },
      { failUnlink: new Set(["old.png"]) },
    );
    // Existing = 900, incoming = 300 -> needs to evict old.png, but unlink fails.
    // Freed = 0. stored = 900 + 300 = 1200 > 1000. Returns false.
    const ok = await makeRoomForUpload("/uploads", 300, cap, fs);
    expect(ok).toBe(false);
    expect(unlinked).toEqual([]);
  });

  test("an incoming file larger than the whole cap returns false immediately", async () => {
    const { fs, unlinked } = fakeCapFs({});
    const ok = await makeRoomForUpload("/uploads", cap + 1, cap, fs);
    expect(ok).toBe(false);
    expect(unlinked).toEqual([]);
  });

  test("uses MAX_UPLOADS_TOTAL_BYTES (200 MB) as default cap", async () => {
    expect(MAX_UPLOADS_TOTAL_BYTES).toBe(200 * 1024 * 1024);
    const { fs } = fakeCapFs({});
    expect(await makeRoomForUpload("/uploads", 1000, undefined, fs)).toBe(true);
  });

  test("skips a file that vanishes between readdir and stat", async () => {
    const { fs, unlinked } = fakeCapFs(
      {
        "old.png": { mtimeMs: 100, size: 400 },
        "racy.png": { mtimeMs: 150, size: 400 },
      },
      { failStat: new Set(["racy.png"]) },
    );
    // racy.png fails stat so it's not in entries. Existing seen = 400 (old.png).
    // incoming = 700. Total = 1100 > 1000 -> evicts old.png (400).
    // Remaining seen = 0 + 700 = 700 <= 1000 -> true.
    const ok = await makeRoomForUpload("/uploads", 700, cap, fs);
    expect(ok).toBe(true);
    expect(unlinked).toEqual(["old.png"]);
  });
});
