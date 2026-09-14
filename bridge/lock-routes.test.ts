import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLockStore, type LockStore } from "./lock.ts";
import { b64u, createChallenges } from "./webauthn.ts";
import {
  lockGate,
  lockStatusRoute,
  lockClearAllRoute,
  webauthnChallengeRoute,
  webauthnUnlockRoute,
  webauthnRegisterRoute,
  webauthnRemoveRoute,
} from "./lock-routes.ts";
import type { Config } from "./config.ts";

const cfg = {
  socketPath: "/tmp/x",
  port: 8787,
  host: "127.0.0.1",
  allowNonLoopbackBind: false,
  pollMs: 1,
  pollIdleMs: 1,
  notifyDelayMs: 1,
  readLines: 10,
  transcript: false,
  journalRoots: { claude: [], pi: [], grok: [] },
  submitKeys: [],
  commandsFile: "",
  keysFile: "",
  trustedUser: "",
  trustedUserOptional: false,
  deviceHeader: "",
  deviceAllowlist: [],
  allowedOrigins: [],
  publicHosts: [],
  pushAllowedHosts: [],
  tailscaleHosts: [],
  allowAnyHost: true,
  vapidPublic: "",
  vapidPrivate: "",
  vapidSubject: "",
  stateDir: "/tmp",
  skipServe: false,
  beacons: false,
  workRoot: "",
  audit: false,
  auditContent: "preview",
} as Config;
const roCfg = { ...cfg, deviceHeader: "x-device" } as Config;

function request(path: string, method = "GET", data?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      host: "127.0.0.1",
      ...(data !== undefined ? { "content-type": "application/json", origin: "http://127.0.0.1" } : {}),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function store(): Promise<LockStore> {
  const s = createLockStore(await mkdtemp(join(tmpdir(), "sightr-lock-route-")));
  await s.addCredential({ id: "device", publicKey: new Uint8Array([4, ...new Uint8Array(64)]), name: "Phone", counter: 0 });
  return s;
}
const url = (p: string) => new URL(`http://127.0.0.1${p}`);
const cat = (...xs: Uint8Array[]) => {
  const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of xs) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const h = (m: number, n: number) => (n < 24 ? Uint8Array.of((m << 5) | n) : Uint8Array.of((m << 5) | 24, n));
const u = (n: number) => h(0, n);
const ni = (n: number) => h(1, -1 - n);
const bs = (b: Uint8Array) => cat(h(2, b.length), b);
const tx = (s: string) => {
  const b = new TextEncoder().encode(s);
  return cat(h(3, b.length), b);
};
const mp = (p: [Uint8Array, Uint8Array][]) => cat(h(5, p.length), ...p.flat());
const { publicKey: routePublic, privateKey: routePrivate } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const routeSpki = routePublic.export({ format: "der", type: "spki" });
const routePoint = new Uint8Array(routeSpki.subarray(routeSpki.length - 65));
const routeAuth = (flags: number, counter: number, id?: Uint8Array, key?: Uint8Array) =>
  cat(
    new Uint8Array(createHash("sha256").update("127.0.0.1").digest()),
    Uint8Array.of(flags),
    Uint8Array.of(counter >>> 24, counter >>> 16, counter >>> 8, counter),
    ...(id ? [new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 255), id, key!] : []),
  );
const routeClient = (type: string, challenge: string) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin: "http://127.0.0.1" }));

describe("device unlock routes", () => {
  test("gate is inert when off and exempts the shell and unlock endpoints", () => {
    const s = createLockStore("/no-such-dir");
    for (const p of ["/api/snapshot", "/api/pane/w1:p1/reply"]) {
      expect(lockGate(request(p), url(p), cfg, s)).toBeNull();
    }
  });

  test("credentials keep the APIs closed but leave the app shell reachable", async () => {
    const s = await store();
    const rows = [
      ["/api/snapshot", "GET"],
      ["/api/pane/w1:p1", "GET"],
      ["/api/pane/w1:p1/reply", "POST"],
    ] as const;
    for (const [p, method] of rows) {
      const r = lockGate(request(p, method), url(p), cfg, s);
      expect(r?.status).toBe(401);
      expect(await r!.text()).toBe("unlock required");
      expect(r!.headers.get("x-sightr-lock")).toBe("required");
    }
    for (const [p, method] of [
      ["/api/lock", "GET"],
      ["/api/lock/webauthn/challenge", "POST"],
      ["/api/lock/webauthn/unlock", "POST"],
      ["/", "GET"],
      ["/index.html", "GET"],
      ["/assets/app.js", "GET"],
      ["/auth/", "GET"],
    ] as const) {
      expect(lockGate(request(p, method), url(p), cfg, s)).toBeNull();
    }
  });

  test("valid, expired and junk cookies are handled", async () => {
    let now = 0;
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-route-"));
    const s = createLockStore(dir, () => now);
    await s.addCredential({ id: "device", publicKey: new Uint8Array([4, ...new Uint8Array(64)]), name: "Phone", counter: 0 });
    const token = s.issue();
    expect(
      lockGate(request("/api/snapshot", "GET", undefined, { cookie: `sightr_lock=${token}` }), url("/api/snapshot"), cfg, s),
    ).toBeNull();
    now = 12 * 60 * 60 * 1000 + 1;
    expect(
      lockGate(request("/api/snapshot", "GET", undefined, { cookie: `sightr_lock=${token}` }), url("/api/snapshot"), cfg, s)?.status,
    ).toBe(401);
    expect(
      lockGate(request("/api/snapshot", "GET", undefined, { cookie: "sightr_lock=junk" }), url("/api/snapshot"), cfg, s)?.status,
    ).toBe(401);
  });

  test("status reports a corrupt store loudly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sightr-lock-route-corrupt-"));
    await Bun.write(join(dir, "lock.json"), "truncated");
    const corrupt = createLockStore(dir);
    expect(await (await lockStatusRoute(request("/api/lock"), url("/api/lock"), cfg, corrupt)).json()).toEqual({
      enabled: false,
      unlocked: true,
      webauthn: false,
      corrupt: true,
      credentials: [],
    });
  });

  test("status reports off, locked and unlocked", async () => {
    const off = createLockStore("/no-such-dir");
    expect(await (await lockStatusRoute(request("/api/lock"), url("/api/lock"), cfg, off)).json()).toEqual({
      enabled: false,
      unlocked: true,
      webauthn: false,
      credentials: [],
    });
    const s = await store();
    expect(await (await lockStatusRoute(request("/api/lock"), url("/api/lock"), cfg, s)).json()).toEqual({
      enabled: true,
      unlocked: false,
      webauthn: true,
      allowCredentials: ["device"],
    });
    const t = s.issue();
    expect(
      await (await lockStatusRoute(request("/api/lock", "GET", undefined, { cookie: `sightr_lock=${t}` }), url("/api/lock"), cfg, s)).json(),
    ).toEqual({
      enabled: true,
      unlocked: true,
      webauthn: true,
      credentials: s.credentials(),
    });
  });

  test("credential-only locks expose only unlock endpoints", async () => {
    const s = await store();
    expect(lockGate(request("/api/snapshot"), url("/api/snapshot"), cfg, s)?.status).toBe(401);
    const challenges = createChallenges();
    expect(webauthnChallengeRoute(request("/api/lock/webauthn/challenge", "POST", { purpose: "assert" }), url("/api/lock/webauthn/challenge"), cfg, s, challenges)).resolves.toMatchObject({ status: 200 });
    expect(lockGate(request("/api/lock/webauthn/challenge", "POST"), url("/api/lock/webauthn/challenge"), cfg, s)).toBeNull();
    expect(webauthnUnlockRoute(request("/api/lock/webauthn/unlock", "POST", {}), url("/api/lock/webauthn/unlock"), cfg, s, challenges)).resolves.toMatchObject({ status: 401 });
    expect(lockGate(request("/api/lock/webauthn/unlock", "POST"), url("/api/lock/webauthn/unlock"), cfg, s)).toBeNull();
    expect(webauthnRegisterRoute(request("/api/lock/webauthn/register", "POST", {}), url("/api/lock/webauthn/register"), cfg, s, challenges)).resolves.toMatchObject({ status: 401 });
    expect(webauthnRemoveRoute(request("/api/lock/webauthn/remove", "POST", { id: "device" }), url("/api/lock/webauthn/remove"), cfg, s)).resolves.toMatchObject({ status: 401 });
    expect(lockGate(request("/api/lock/webauthn/register", "POST"), url("/api/lock/webauthn/register"), cfg, s)?.status).toBe(401);
    expect(challenges.size()).toBeGreaterThan(0);
  });

  test("WebAuthn assertion unlocks and unknown ids fail without cookies", async () => {
    const s = createLockStore(await mkdtemp(join(tmpdir(), "sightr-cred-")));
    const id = new Uint8Array([1, 2, 3]);
    await s.addCredential({ id: b64u(id), publicKey: routePoint, name: "Phone", counter: 0 });
    const ch = createChallenges();
    const challenge = await webauthnChallengeRoute(
      request("/api/lock/webauthn/challenge", "POST", { purpose: "assert" }),
      url("/api/lock/webauthn/challenge"),
      cfg,
      s,
      ch,
    );
    const opts = (await challenge.json()) as { challenge: string };
    const cd = routeClient("webauthn.get", opts.challenge);
    const ad = routeAuth(0x05, 0);
    const sig = new Uint8Array(cryptoSign("sha256", cat(ad, new Uint8Array(createHash("sha256").update(cd).digest())), routePrivate));
    const good = await webauthnUnlockRoute(
      request("/api/lock/webauthn/unlock", "POST", {
        id: b64u(id),
        clientDataJSON: Buffer.from(cd).toString("base64url"),
        authenticatorData: Buffer.from(ad).toString("base64url"),
        signature: Buffer.from(sig).toString("base64url"),
      }),
      url("/api/lock/webauthn/unlock"),
      cfg,
      s,
      ch,
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("set-cookie")).toContain("sightr_lock=");
    const bad = await webauthnUnlockRoute(
      request("/api/lock/webauthn/unlock", "POST", { id: "unknown", clientDataJSON: "x", authenticatorData: "x", signature: "x" }),
      url("/api/lock/webauthn/unlock"),
      cfg,
      s,
      ch,
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  test("WebAuthn assertion rejects a bad signature", async () => {
    const s = createLockStore(await mkdtemp(join(tmpdir(), "sightr-bad-signature-")));
    const id = new Uint8Array([4, 5, 6]);
    await s.addCredential({ id: b64u(id), publicKey: routePoint, name: "Phone", counter: 0 });
    const challenges = createChallenges();
    const challengeResponse = await webauthnChallengeRoute(
      request("/api/lock/webauthn/challenge", "POST", { purpose: "assert" }),
      url("/api/lock/webauthn/challenge"),
      cfg,
      s,
      challenges,
    );
    const { challenge } = (await challengeResponse.json()) as { challenge: string };
    const clientData = routeClient("webauthn.get", challenge);
    const authenticatorData = routeAuth(0x05, 1);
    const signature = new Uint8Array(cryptoSign("sha256", cat(authenticatorData, new Uint8Array(createHash("sha256").update(clientData).digest())), routePrivate));
    signature[0]! ^= 1;
    const response = await webauthnUnlockRoute(
      request("/api/lock/webauthn/unlock", "POST", {
        id: b64u(id),
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
      }),
      url("/api/lock/webauthn/unlock"),
      cfg,
      s,
      challenges,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(s.credential(b64u(id))!.counter).toBe(0);

    const freshChallengeResponse = await webauthnChallengeRoute(
      request("/api/lock/webauthn/challenge", "POST", { purpose: "assert" }),
      url("/api/lock/webauthn/challenge"),
      cfg,
      s,
      challenges,
    );
    const { challenge: freshChallenge } = (await freshChallengeResponse.json()) as { challenge: string };
    const freshClientData = routeClient("webauthn.get", freshChallenge);
    const freshAuthenticatorData = routeAuth(0x05, 4);
    const freshSignature = new Uint8Array(cryptoSign("sha256", cat(freshAuthenticatorData, new Uint8Array(createHash("sha256").update(freshClientData).digest())), routePrivate));
    const recovered = await webauthnUnlockRoute(
      request("/api/lock/webauthn/unlock", "POST", {
        id: b64u(id),
        clientDataJSON: b64u(freshClientData),
        authenticatorData: b64u(freshAuthenticatorData),
        signature: b64u(freshSignature),
      }),
      url("/api/lock/webauthn/unlock"),
      cfg,
      s,
      challenges,
    );
    expect(recovered.status).toBe(200);
    expect(s.credential(b64u(id))!.counter).toBe(4);
  });

  test("locked status hides credential metadata", async () => {
    const s = createLockStore(await mkdtemp(join(tmpdir(), "sightr-cred-")));
    await s.addCredential({ id: "device", publicKey: new Uint8Array([4, ...new Uint8Array(64)]), name: "Secret phone", counter: 0 });
    const response = await lockStatusRoute(request("/api/lock"), url("/api/lock"), cfg, s);
    const body = (await response.json()) as { allowCredentials: string[] };
    expect(body.allowCredentials).toEqual(["device"]);
    expect(JSON.stringify(body)).not.toContain("Secret phone");
    expect(JSON.stringify(body)).not.toContain("publicKey");
  });

  test("read-only devices cannot register or remove credentials", async () => {
    const s = await store();
    const ch = createChallenges();
    const noSession = await webauthnRegisterRoute(
      request("/api/lock/webauthn/register", "POST", {}),
      url("/api/lock/webauthn/register"),
      cfg,
      s,
      ch,
    );
    expect(noSession.status).toBe(401);
    const remove = await webauthnRemoveRoute(
      request("/api/lock/webauthn/remove", "POST", { id: "x" }),
      url("/api/lock/webauthn/remove"),
      roCfg,
      s,
    );
    expect(remove.status).toBe(403);
    const register = await webauthnRegisterRoute(
      request("/api/lock/webauthn/register", "POST", {}, { "x-device": "other" }),
      url("/api/lock/webauthn/register"),
      roCfg,
      s,
      ch,
    );
    expect(register.status).toBe(403);
  });

  test("registers with a session and read-only devices can unlock", async () => {
    const s = createLockStore(await mkdtemp(join(tmpdir(), "sightr-cred-")));
    const first = new Uint8Array([9, 9, 9]);
    await s.addCredential({ id: b64u(first), publicKey: routePoint, name: "Phone", counter: 0 });
    const id = new Uint8Array([5, 6, 7]);
    const ch = createChallenges();
    const session = s.issue();
    const challenge = await webauthnChallengeRoute(
      request("/api/lock/webauthn/challenge", "POST", { purpose: "register" }, { cookie: `sightr_lock=${session}` }),
      url("/api/lock/webauthn/challenge"),
      cfg,
      s,
      ch,
    );
    const opts = (await challenge.json()) as { challenge: string };
    const cd = routeClient("webauthn.create", opts.challenge);
    const cose = mp([
      [u(1), u(2)],
      [u(3), ni(-7)],
      [ni(-1), u(1)],
      [ni(-2), bs(routePoint.slice(1, 33))],
      [ni(-3), bs(routePoint.slice(33))],
    ]);
    const ad = routeAuth(0x45, 0, id, cose);
    const registered = await webauthnRegisterRoute(
      request(
        "/api/lock/webauthn/register",
        "POST",
        {
          id: b64u(id),
          clientDataJSON: Buffer.from(cd).toString("base64url"),
          authenticatorData: Buffer.from(ad).toString("base64url"),
          attestationObject: Buffer.from(
            mp([
              [tx("fmt"), tx("none")],
              [tx("attStmt"), mp([])],
              [tx("authData"), bs(ad)],
            ]),
          ).toString("base64url"),
          name: "Desktop",
        },
        { cookie: `sightr_lock=${session}` },
      ),
      url("/api/lock/webauthn/register"),
      cfg,
      s,
      ch,
    );
    expect(registered.status).toBe(200);
    expect(s.credentials()).toHaveLength(2);

    const roChallenge = await webauthnChallengeRoute(
      request("/api/lock/webauthn/challenge", "POST", { purpose: "assert" }, { "x-device": "other" }),
      url("/api/lock/webauthn/challenge"),
      roCfg,
      s,
      ch,
    );
    const roOpts = (await roChallenge.json()) as { challenge: string };
    const roCd = routeClient("webauthn.get", roOpts.challenge);
    const roAd = routeAuth(0x05, 0);
    const roSig = new Uint8Array(cryptoSign("sha256", cat(roAd, new Uint8Array(createHash("sha256").update(roCd).digest())), routePrivate));
    const unlocked = await webauthnUnlockRoute(
      request(
        "/api/lock/webauthn/unlock",
        "POST",
        {
          id: b64u(first),
          clientDataJSON: Buffer.from(roCd).toString("base64url"),
          authenticatorData: Buffer.from(roAd).toString("base64url"),
          signature: Buffer.from(roSig).toString("base64url"),
        },
        { "x-device": "other" },
      ),
      url("/api/lock/webauthn/unlock"),
      roCfg,
      s,
      ch,
    );
    expect(unlocked.status).toBe(200);
  });

  test("clear-all turns the gate off", async () => {
    const s = await store();
    await lockClearAllRoute(request("/api/lock/clear-all", "POST"), url("/api/lock/clear-all"), cfg, s);
    expect(s.enabled()).toBe(false);
  });

  test("only status, challenge and unlock bypass the gate — other /api/lock paths are gated", async () => {
    const s = await store();
    expect(lockGate(request("/api/lock/unlock", "POST"), url("/api/lock/unlock"), cfg, s)?.status).toBe(401);
    expect(lockGate(request("/api/lock/set", "POST"), url("/api/lock/set"), cfg, s)?.status).toBe(401);
    expect(lockGate(request("/api/lock/clear", "POST"), url("/api/lock/clear"), cfg, s)?.status).toBe(401);
  });
});
