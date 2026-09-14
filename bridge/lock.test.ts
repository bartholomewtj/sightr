import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearedCookie,
  createLockStore,
  readCookie,
  sessionCookie,
  wantsSecureCookie,
  SESSION_IDLE_MS,
} from "./lock.ts";

const point = () => {
  const publicKey = new Uint8Array(65);
  publicKey[0] = 4;
  return publicKey;
};

describe("reconnect lock store", () => {
  test("parses cookies and formats persistent cookies", () => {
    expect(readCookie("a=1; sightr_lock=abc; z=2", "sightr_lock")).toBe("abc");
    expect(readCookie(" a=1 ; sightr_lock=abc ", "sightr_lock")).toBe("abc");
    expect(readCookie("sightr_lock=", "sightr_lock")).toBeNull();
    expect(readCookie(null, "sightr_lock")).toBeNull();
    expect(sessionCookie("abc", true)).toContain("HttpOnly");
    expect(sessionCookie("abc", true)).toContain("Secure");
    expect(sessionCookie("abc", false)).not.toContain("Secure");
    expect(sessionCookie("abc", false)).toContain("Max-Age=2592000");
    expect(clearedCookie(false)).toContain("Max-Age=0");
    expect(wantsSecureCookie(new Request("http://x"), new URL("http://x"))).toBe(false);
    expect(
      wantsSecureCookie(new Request("http://x", { headers: { "x-forwarded-proto": "https" } }), new URL("http://x")),
    ).toBe(true);
    expect(wantsSecureCookie(new Request("https://x"), new URL("https://x"))).toBe(true);
  });

  test("unknown keys in the store file do not turn the gate on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-hash-"));
    await Bun.write(join(dir, "lock.json"), JSON.stringify({ version: 1, hash: "leftover", updatedAt: 0 }));
    const store = createLockStore(dir);
    expect(store.enabled()).toBe(false);
    expect(store.credentials()).toEqual([]);
  });


  test("credentials persist and enable the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-cred-"));
    const store = createLockStore(dir);
    expect(store.enabled()).toBe(false);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    const raw = await readFile(join(dir, "lock.json"), "utf8");
    expect(raw).not.toContain("hash");
    expect(JSON.parse(raw).credentials[0]).not.toHaveProperty("hash");
    const fresh = createLockStore(dir);
    expect(fresh.enabled()).toBe(true);
    expect(fresh.credentials().map((c) => c.id)).toEqual(["device"]);
    expect(JSON.stringify(fresh.credentials())).not.toContain("publicKey");
  });

  test("sets aside a truncated store and reports it as corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-corrupt-"));
    const truncated = '{"credentials":[';
    await Bun.write(join(dir, "lock.json"), truncated);
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const store = createLockStore(dir, () => 123);
      expect(store.corrupt()).toBe(true);
      expect(store.enabled()).toBe(false);
      expect(await Bun.file(join(dir, "lock.json")).exists()).toBe(false);
      expect(await Bun.file(join(dir, "lock.json.corrupt-123")).text()).toBe(truncated);
      expect(errors.flat().some((value) => String(value).includes("lock.json"))).toBe(true);
      await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
      expect(store.corrupt()).toBe(false);
      const fresh = createLockStore(dir);
      expect(fresh.credentials().map((c) => c.id)).toEqual(["device"]);
    } finally {
      console.error = originalError;
    }
  });

  test("a failed rename leaves the previous store intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-rename-"));
    const store = createLockStore(dir);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    const before = await readFile(join(dir, "lock.json"), "utf8");
    let fail = true;
    const broken = createLockStore(dir, Date.now, async (from, to) => {
      if (fail) {
        fail = false;
        throw new Error("rename failed");
      }
      await rename(from, to);
    });
    await expect(broken.updateCounter("device", 1)).rejects.toThrow("rename failed");
    expect(await readFile(join(dir, "lock.json"), "utf8")).toBe(before);
    expect(await Bun.file(join(dir, "lock.json.tmp")).exists()).toBe(false);
    await broken.addCredential({ id: "second", publicKey: point(), name: "Desktop", counter: 0 });
    expect(JSON.parse(await readFile(join(dir, "lock.json"), "utf8")).credentials).toHaveLength(2);
  });

  test("serialises concurrent counter saves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-serial-"));
    const store = createLockStore(dir);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const serial = createLockStore(dir, Date.now, async (from, to) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(JSON.parse(await readFile(from, "utf8")).credentials[0].counter);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await rename(from, to);
      active--;
    });
    await Promise.all([serial.updateCounter("device", 1), serial.updateCounter("device", 2)]);
    expect(maxActive).toBe(1);
    expect(order.slice(-2)).toEqual([1, 2]);
    expect(JSON.parse(await readFile(join(dir, "lock.json"), "utf8")).credentials[0].counter).toBe(2);
  });

  test("sessions expire on a sliding idle window and die across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-sess-"));
    let clock = 0;
    const store = createLockStore(dir, () => clock);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    const token = store.issue();
    expect(store.valid(token)).toBe(true);
    clock = 6 * 60 * 60 * 1000;
    expect(store.valid(token)).toBe(true);
    clock += 11 * 60 * 60 * 1000;
    expect(store.valid(token)).toBe(true);
    clock += SESSION_IDLE_MS + 1;
    expect(store.valid(token)).toBe(false);
    expect(store.sessionCount()).toBe(0);
    const second = createLockStore(dir, () => clock);
    expect(second.enabled()).toBe(true);
    expect(second.valid(token)).toBe(false);
  });

  test("clearAll removes credentials and the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-clear-"));
    const store = createLockStore(dir);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    expect(store.enabled()).toBe(true);
    await store.clearAll();
    expect(store.enabled()).toBe(false);
    expect(store.credentials()).toEqual([]);
  });

  test("removing the last credential turns the gate off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-last-"));
    const store = createLockStore(dir);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    await store.removeCredential("device");
    expect(store.enabled()).toBe(false);
  });

  test("caps sessions and writes owner-only on POSIX", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-cap-"));
    const store = createLockStore(dir);
    await store.addCredential({ id: "device", publicKey: point(), name: "Phone", counter: 0 });
    for (let i = 0; i < 40; i++) store.issue();
    expect(store.sessionCount()).toBeLessThanOrEqual(32);
    if (process.platform !== "win32") expect((await stat(join(dir, "lock.json"))).mode & 0o777).toBe(0o600);
  });
});
