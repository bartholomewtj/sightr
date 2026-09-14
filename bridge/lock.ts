import { randomBytes, createHash } from "node:crypto";
import { chmod, unlink, rename } from "node:fs/promises";
import { writeJsonAtomic } from "./json-file.ts";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LOCK_COOKIE = "sightr_lock";
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_SESSIONS = 32;

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${LOCK_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
export const sessionCookie = (token: string, secure: boolean) => cookie(token, COOKIE_MAX_AGE_S, secure);
export const clearedCookie = (secure: boolean) => cookie("", 0, secure);
export function wantsSecureCookie(req: Request, url: URL): boolean {
  return req.headers.get("x-forwarded-proto") === "https" || url.protocol === "https:";
}

export interface StoredCredentialMeta {
  id: string;
  name: string;
  addedAt: number;
}

export interface LockStore {
  enabled(): boolean;
  clearAll(): Promise<void>;
  issue(): string;
  valid(token: string | null): boolean;
  sessionCount(): number;
  credentials(): StoredCredentialMeta[];
  credentialIds(): string[];
  credential(id: string): { publicKey: Uint8Array; counter: number } | null;
  addCredential(c: { id: string; publicKey: Uint8Array; name: string; counter: number }): Promise<void>;
  removeCredential(id: string): Promise<void>;
  updateCounter(id: string, counter: number): Promise<void>;
  userId(): Uint8Array;
  corrupt(): boolean;
}

interface StoredCredential {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  name: string;
  addedAt: number;
}

export function createLockStore(
  stateDir: string,
  now = Date.now,
  renameFile: (from: string, to: string) => Promise<void> = rename,
): LockStore {
  const file = join(stateDir, "lock.json");
  let user: Uint8Array | null = null;
  let creds: StoredCredential[] = [];
  let isCorrupt = false;
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid lock store shape");
      // The gate is device credentials only; unknown keys in the file are ignored.
      if (typeof data.userId === "string") user = new Uint8Array(Buffer.from(data.userId, "base64url"));
      if (Array.isArray(data.credentials)) {
        creds = data.credentials
          .filter(
            (c: { id?: unknown; publicKey?: unknown; name?: unknown }) =>
              typeof c?.id === "string" && typeof c?.publicKey === "string" && typeof c?.name === "string",
          )
          .map((c: { id: string; publicKey: string; name: string; counter?: number; addedAt?: number }) => ({
            id: c.id,
            publicKey: new Uint8Array(Buffer.from(c.publicKey, "base64url")),
            counter: typeof c.counter === "number" ? c.counter : 0,
            name: c.name,
            addedAt: typeof c.addedAt === "number" ? c.addedAt : 0,
          }));
      }
    }
  } catch {
    user = null;
    creds = [];
    isCorrupt = true;
    const corruptFile = `${file}.corrupt-${now()}`;
    try {
      renameSync(file, corruptFile);
      console.error(`[bridge] lock: corrupt credential store set aside at ${corruptFile}`);
    } catch (err) {
      console.error(`[bridge] lock: could not set aside corrupt file ${file}`, err);
    }
  }

  const sessions = new Map<string, number>();
  const key = (token: string) => createHash("sha256").update(token).digest("hex");
  const prune = () => {
    const t = now();
    for (const [k, used] of sessions) if (t - used > SESSION_IDLE_MS) sessions.delete(k);
  };

  let saveChain: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    const run = saveChain.then(work, work);
    saveChain = run.catch(() => {});
    return run;
  };

  const save = async () => {
    // Snapshot the payload before waiting, while this operation's state is current.
    const payload = {
      version: 2,
      ...(user ? { userId: Buffer.from(user).toString("base64url") } : {}),
      credentials: creds.map((c) => ({
        id: c.id,
        publicKey: Buffer.from(c.publicKey).toString("base64url"),
        counter: c.counter,
        name: c.name,
        addedAt: c.addedAt,
      })),
      updatedAt: now(),
    };
    return enqueue(async () => {
      await writeJsonAtomic(file, payload, { rename: renameFile });
      if (process.platform !== "win32") await chmod(file, 0o600);
      isCorrupt = false;
    });
  };

  const dropFile = () =>
    enqueue(async () => {
      try {
        await unlink(file);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      isCorrupt = false;
    });

  return {
    enabled: () => creds.length > 0,
    corrupt: () => isCorrupt,
    async clearAll() {
      creds = [];
      user = null;
      sessions.clear();
      await dropFile();
    },
    issue() {
      prune();
      const token = randomBytes(32).toString("base64url");
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      sessions.set(key(token), now());
      return token;
    },
    valid(token) {
      if (!token) return false;
      const k = key(token);
      const used = sessions.get(k);
      if (used === undefined) return false;
      if (now() - used > SESSION_IDLE_MS) {
        sessions.delete(k);
        return false;
      }
      sessions.set(k, now());
      return true;
    },
    sessionCount: () => sessions.size,
    credentials: () => creds.map(({ id, name, addedAt }) => ({ id, name, addedAt })),
    credentialIds: () => creds.map((c) => c.id),
    credential(id) {
      const c = creds.find((x) => x.id === id);
      return c ? { publicKey: c.publicKey, counter: c.counter } : null;
    },
    async addCredential(c) {
      if (creds.some((x) => x.id === c.id)) throw new Error("duplicate");
      if (!user) user = randomBytes(16);
      creds.push({ ...c, addedAt: now() });
      await save();
    },
    async removeCredential(id) {
      creds = creds.filter((c) => c.id !== id);
      if (!creds.length) await dropFile();
      else await save();
    },
    async updateCounter(id, counter) {
      const c = creds.find((x) => x.id === id);
      if (c) {
        c.counter = counter;
        await save();
      }
    },
    userId() {
      // Cache only — the next addCredential write persists it. A restart mid-ceremony generates a
      // fresh id, which is harmless because no credential exists yet.
      if (!user) user = randomBytes(16);
      return user;
    },
  };
}
