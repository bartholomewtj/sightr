import { describe, expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";

import {
  DEFAULT_SUBJECT,
  generateVapidKeys,
  mergeEnv,
  readEnvVar,
  validateSubject,
} from "./push-keys.ts";

// Two things can go wrong here and neither shows up until much later: a keypair that isn't actually
// a valid P-256 point (the push service answers 400, hours after setup), and an .env rewrite that
// loses or duplicates a line (the operator's other settings quietly stop applying). So the keys are
// checked by feeding them back into node:crypto as a real key, and the merge is checked against the
// file shapes an operator actually has — empty, copied-from-.env.example, and already-configured.

describe("generateVapidKeys", () => {
  test("produces an uncompressed P-256 point node:crypto will re-import", () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const raw = Buffer.from(publicKey, "base64url");
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(Buffer.from(privateKey, "base64url").length).toBe(32);

    // The real assertion: rebuild a JWK from our own encoding and let node:crypto validate that the
    // point is on the curve. A mis-sliced X/Y would still be 65 bytes and would still fail here.
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(key.asymmetricKeyType).toBe("ec");
  });

  test("is a fresh keypair each call", () => {
    expect(generateVapidKeys().privateKey).not.toBe(generateVapidKeys().privateKey);
  });
});

describe("readEnvVar", () => {
  test("reads a live assignment and ignores a commented placeholder", () => {
    expect(readEnvVar("# SIGHTR_VAPID_PUBLIC=\nSIGHTR_VAPID_PUBLIC=abc\n", "SIGHTR_VAPID_PUBLIC")).toBe("abc");
    expect(readEnvVar("# SIGHTR_VAPID_PUBLIC=old\n", "SIGHTR_VAPID_PUBLIC")).toBeUndefined();
  });

  test("an empty assignment is not a value", () => {
    expect(readEnvVar("SIGHTR_VAPID_PUBLIC=\n", "SIGHTR_VAPID_PUBLIC")).toBeUndefined();
  });

  test("the last assignment wins, as bash would have it", () => {
    expect(readEnvVar("SIGHTR_VAPID_PUBLIC=one\nSIGHTR_VAPID_PUBLIC=two\n", "SIGHTR_VAPID_PUBLIC")).toBe("two");
  });
});

describe("mergeEnv", () => {
  test("appends to a file that has no VAPID lines, keeping what was there", () => {
    const out = mergeEnv("SIGHTR_PORT=8787\n", { SIGHTR_VAPID_PUBLIC: "pub" });
    expect(out).toContain("SIGHTR_PORT=8787");
    expect(out).toContain("SIGHTR_VAPID_PUBLIC=pub");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  test("takes over a commented placeholder in place rather than appending below it", () => {
    const out = mergeEnv("# --- Web Push ---\n# SIGHTR_VAPID_PUBLIC=\n# SIGHTR_VAPID_PRIVATE=\n", {
      SIGHTR_VAPID_PUBLIC: "pub",
    });
    expect(out.split("\n")[1]).toBe("SIGHTR_VAPID_PUBLIC=pub");
    expect(out).toContain("# SIGHTR_VAPID_PRIVATE=");
  });

  test("leaves no second copy of a key it replaced", () => {
    const out = mergeEnv("SIGHTR_VAPID_PRIVATE=old\nSIGHTR_PORT=1\n# SIGHTR_VAPID_PRIVATE=older\n", {
      SIGHTR_VAPID_PRIVATE: "new",
    });
    expect(out.match(/SIGHTR_VAPID_PRIVATE/g)?.length).toBe(1);
    expect(out).toContain("SIGHTR_VAPID_PRIVATE=new");
    expect(out).toContain("SIGHTR_PORT=1");
  });

  test("replaces an `export`-prefixed assignment instead of appending beside it", () => {
    const out = mergeEnv("export SIGHTR_VAPID_PRIVATE=old\n", { SIGHTR_VAPID_PRIVATE: "new" });
    expect(out.match(/SIGHTR_VAPID_PRIVATE/g)?.length).toBe(1);
    expect(out).not.toContain("old");
  });

  test("creates a file from nothing", () => {
    const out = mergeEnv("", { SIGHTR_VAPID_SUBJECT: DEFAULT_SUBJECT });
    expect(out).toContain(`SIGHTR_VAPID_SUBJECT=${DEFAULT_SUBJECT}`);
  });
});

describe("validateSubject", () => {
  test("accepts the two forms RFC 8292 names", () => {
    expect(validateSubject("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(validateSubject("https://example.com/sightr")).toBe("https://example.com/sightr");
  });

  // The allowlist exists because a value holding shell metacharacters means different things to
  // different .env readers. Every case below is one the old blocklist let through.
  test("rejects anything bash would read as more than a value", () => {
    for (const bad of [
      "me@example.com",
      "mailto:me example.com",
      'mailto:a@b"',
      "mailto:a@b$(id)",
      "https://x/;id",
      "https://x/&id",
      "https://x/|id",
      "https://x/`id`",
      "https://x/$(id)",
      "https://x/~root",
      "https://x/(id)",
      "https://x/\nSIGHTR_TRUSTED_USER=",
    ]) {
      expect(() => validateSubject(bad)).toThrow();
    }
  });
});
