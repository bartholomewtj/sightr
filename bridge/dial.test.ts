import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dialHerdr, toPipeName } from "./dial.ts";

// toPipeName is pure and runs everywhere. The live-dial suite runs everywhere too: node:net
// addresses a named pipe on win32 and an AF_UNIX path elsewhere, so the same code is exercised on
// any CI runner. The only genuinely win32-specific step is the pipe-name mapping.

describe("toPipeName", () => {
  test("prefixes a plain socket path with the pipe namespace", () => {
    expect(toPipeName("C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock")).toBe(
      "\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock",
    );
  });

  test("passes an already-prefixed pipe name through unchanged", () => {
    expect(toPipeName("\\\\.\\pipe\\already-a-pipe")).toBe("\\\\.\\pipe\\already-a-pipe");
    expect(toPipeName("//./pipe/already-a-pipe")).toBe("//./pipe/already-a-pipe");
  });
});

describe("dialHerdr over a live endpoint", () => {
  // POSIX needs a real filesystem path for the AF_UNIX socket; win32 pipe names are namespaced and
  // need no temp dir at all. Cleaned up either way.
  const dir = process.platform === "win32" ? null : mkdtempSync(join(tmpdir(), "sightr-dial-"));
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const pipeFor = (tag: string) =>
    dir === null
      ? `\\\\.\\pipe\\sightr-dial-test-${process.pid}-${tag}`
      : join(dir, `${tag}.sock`);

  /** One-connection line server: waits for a request line, replies with `chunks`, then closes. */
  const serveOnce = async (pipe: string, chunks: Buffer[], gapMs = 0): Promise<net.Server> => {
    const server = net.createServer((conn) => {
      conn.once("data", () => {
        let i = 0;
        const writeNext = () => {
          if (i >= chunks.length) {
            conn.end();
            return;
          }
          conn.write(chunks[i++]!);
          setTimeout(writeNext, gapMs);
        };
        writeNext();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, resolve);
    });
    return server;
  };

  /** Dial, send one request line, resolve with everything received up to the first newline. */
  const requestLine = (pipe: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const received: Buffer[] = [];
      let settled = false;
      const once = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      dialHerdr(pipe, {
        data(_s, chunk) {
          received.push(Buffer.from(chunk));
          const text = Buffer.concat(received).toString("utf-8");
          if (text.includes("\n")) once(() => resolve(text.slice(0, text.indexOf("\n"))));
        },
        error(_s, err) {
          once(() => reject(err));
        },
        close() {
          once(() => reject(new Error("closed before a full reply line")));
        },
      })
        .then((s) => s.write('{"id":"t","method":"probe","params":{}}\n'))
        .catch((err) => once(() => reject(err)));
    });

  test("one-shot request/reply round-trips, accepting an already-prefixed pipe name", async () => {
    const pipe = pipeFor("roundtrip");
    const server = await serveOnce(pipe, [Buffer.from('{"ok":true}\n', "utf-8")]);
    try {
      expect(await requestLine(pipe)).toBe('{"ok":true}');
    } finally {
      server.close();
    }
  });

  test("a reply split mid-codepoint across chunks reassembles byte-perfect", async () => {
    const pipe = pipeFor("split");
    const payload = Buffer.from('{"emoji":"🐕🦮"}\n', "utf-8");
    const cut = 12; // inside the first emoji's 4-byte sequence
    const server = await serveOnce(pipe, [payload.subarray(0, cut), payload.subarray(cut)], 15);
    try {
      expect(await requestLine(pipe)).toBe('{"emoji":"🐕🦮"}');
    } finally {
      server.close();
    }
  });

  test("dialing a nonexistent endpoint rejects and fires the error handler", async () => {
    let sawError = false;
    await expect(
      dialHerdr(pipeFor("nonexistent"), {
        error() {
          sawError = true;
        },
      }),
    ).rejects.toBeDefined();
    expect(sawError).toBe(true);
  });

  // Pins the backpressure contract: a long request (a big paste, a wide pane's text) must arrive
  // whole even when the socket cannot take it in one go. node:net's write() queues instead of
  // short-writing; this keeps that claim honest rather than merely asserted in a comment. The server
  // refuses to read for a beat, which fills the kernel buffer on any machine; a truncated request
  // would hang until the assertion's own await gives up.
  {
    test("a payload far past the short-write threshold arrives whole", async () => {
      const pipe = pipeFor("backpressure");
      // ~1 MB of distinguishable, newline-free filler: a lost tail is a length mismatch AND a
      // content mismatch, so a partial reassembly can't accidentally pass.
      const filler = "0123456789abcdef".repeat(64 * 1024);
      const request = `{"id":"t","method":"probe","params":{"text":"${filler}"}}\n`;
      const requestBytes = Buffer.byteLength(request, "utf-8");

      const seen: { line: string | null } = { line: null };
      const server = net.createServer((conn) => {
        // Don't read for a beat: the kernel buffer fills and the client's write is forced short.
        conn.pause();
        setTimeout(() => conn.resume(), 50);
        const chunks: Buffer[] = [];
        conn.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          const text = Buffer.concat(chunks).toString("utf-8");
          if (!text.includes("\n")) return;
          seen.line = text.slice(0, text.indexOf("\n"));
          conn.write('{"id":"t","result":{"ok":true}}\n');
          conn.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, resolve);
      });

      try {
        const reply = await new Promise<string>((resolve, reject) => {
          const out: Buffer[] = [];
          let settled = false;
          const once = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
          };
          const timer = setTimeout(() => once(() => reject(new Error("no reply — request truncated?"))), 5000);
          dialHerdr(pipe, {
            data(_s, chunk) {
              out.push(Buffer.from(chunk));
              const text = Buffer.concat(out).toString("utf-8");
              if (text.includes("\n")) {
                clearTimeout(timer);
                once(() => resolve(text.slice(0, text.indexOf("\n"))));
              }
            },
            error(_s, err) {
              clearTimeout(timer);
              once(() => reject(err));
            },
            close() {
              clearTimeout(timer);
              once(() => reject(new Error("closed before a full reply line")));
            },
          })
            .then((s) => s.write(request))
            .catch((err) => once(() => reject(err)));
        });

        expect(reply).toBe('{"id":"t","result":{"ok":true}}');
        expect(seen.line).not.toBeNull();
        // The newline is the frame delimiter and isn't part of the captured line.
        expect(Buffer.byteLength(seen.line!, "utf-8")).toBe(requestBytes - 1);
        expect(seen.line).toBe(request.slice(0, -1));
      } finally {
        server.close();
      }
    }, 15000);
  }

  test("onDial cancel settles the promise instead of leaving it pending", async () => {
    let cancel: (() => void) | null = null;
    const p = dialHerdr(pipeFor("cancelled"), {
      onDial(c) {
        cancel = c;
      },
    });
    expect(cancel).not.toBeNull();
    cancel!();
    // Whether the abort lands as "closed before connect" or the connect error races first,
    // the promise must settle — a caller that already timed out must not leak a pending dial.
    await expect(p).rejects.toBeDefined();
  });
});
