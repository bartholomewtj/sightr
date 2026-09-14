import type { Config } from "./config.ts";
import { SILENT_AUDIT, type AuditLog } from "./audit.ts";
import { checkAccess, guard } from "./access.ts";
import { json, requireJsonBody, secure, text } from "./responses.ts";
import { clearedCookie, LOCK_COOKIE, readCookie, sessionCookie, wantsSecureCookie, type LockStore } from "./lock.ts";
import { b64u, fromB64u, type Challenges, verifyCreate, verifyGet } from "./webauthn.ts";

export { readCookie, sessionCookie, clearedCookie, wantsSecureCookie } from "./lock.ts";

const bad = (status = 401) =>
  secure(
    new Response(JSON.stringify({ ok: false }), {
      status,
      headers: {
        "content-type": "application/json",
        ...(status === 401 ? { "x-sightr-lock": "required" } : {}),
      },
    }),
  );

const body = async (req: Request) => {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

export function lockGate(
  req: Request,
  url: URL,
  _cfg: Config,
  lock: LockStore,
  ownsExtra: (pathname: string) => boolean,
  extraExempt?: (req: Request, url: URL) => boolean,
): Response | null {
  if (!lock.enabled()) return null;
  const api = url.pathname.startsWith("/api/");
  const gated = api || (ownsExtra(url.pathname) && !(extraExempt?.(req, url) ?? false));
  const exempt =
    (url.pathname === "/api/lock" && req.method === "GET") ||
    (url.pathname === "/api/lock/webauthn/challenge" && req.method === "POST") ||
    (url.pathname === "/api/lock/webauthn/unlock" && req.method === "POST");
  if (!gated || exempt || lock.valid(readCookie(req.headers.get("cookie"), LOCK_COOKIE))) return null;
  return secure(
    new Response("unlock required", {
      status: 401,
      headers: {
        "x-sightr-lock": "required",
        "cache-control": "no-store",
        "set-cookie": clearedCookie(wantsSecureCookie(req, url)),
      },
    }),
  );
}

export function lockStatusRoute(req: Request, _url: URL, cfg: Config, lock: LockStore): Response {
  const access = checkAccess(req, cfg, "read");
  if (!access.ok) return text(access.reason, 403);
  const unlocked = !lock.enabled() || lock.valid(readCookie(req.headers.get("cookie"), LOCK_COOKIE));
  const base = {
    enabled: lock.enabled(),
    unlocked,
    webauthn: lock.credentialIds().length > 0,
    ...(lock.corrupt() ? { corrupt: true } : {}),
  };
  return json(unlocked ? { ...base, credentials: lock.credentials() } : { ...base, allowCredentials: lock.credentialIds() }, null, 200);
}

export async function lockClearAllRoute(req: Request, url: URL, cfg: Config, lock: LockStore, audit: AuditLog = SILENT_AUDIT): Promise<Response> {
  const denied = guard(req, cfg, "write");
  if (denied) return denied;
  await lock.clearAll();
  audit.record({ action: "lock.clear-all", detail: {} });
  return secure(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": clearedCookie(wantsSecureCookie(req, url)) },
    }),
  );
}

function originOf(req: Request, url: URL): string {
  return req.headers.get("origin") ?? url.origin;
}
function rpId(req: Request, url: URL): string {
  return (req.headers.get("host") ?? url.host).replace(/:\d+$/, "");
}

export async function webauthnChallengeRoute(
  req: Request,
  url: URL,
  cfg: Config,
  lock: LockStore,
  challenges: Challenges,
): Promise<Response> {
  const access = checkAccess(req, cfg, "write");
  if (!access.ok) return text(access.reason, 403);
  const typed = requireJsonBody(req);
  if (typed) return typed;
  const v = await body(req);
  if (v.purpose !== "assert" && v.purpose !== "register") return text("bad purpose", 400);
  if (v.purpose === "register" && lock.enabled() && !lock.valid(readCookie(req.headers.get("cookie"), LOCK_COOKIE))) {
    return bad();
  }
  const challenge = challenges.issue(v.purpose);
  return json(
    {
      challenge,
      rpId: rpId(req, url),
      rpName: "Sightr",
      userId: b64u(lock.userId()),
      allowCredentials: lock.credentialIds(),
      timeout: 60000,
    },
    null,
  );
}

export async function webauthnUnlockRoute(
  req: Request,
  url: URL,
  cfg: Config,
  lock: LockStore,
  challenges: Challenges,
): Promise<Response> {
  const access = checkAccess(req, cfg, "write");
  if (!access.ok) return text(access.reason, 403);
  const typed = requireJsonBody(req);
  if (typed) return typed;
  const v = await body(req);
  try {
    if (typeof v.id !== "string") return bad();
    const clientData = fromB64u(String(v.clientDataJSON));
    const parsed = JSON.parse(new TextDecoder().decode(clientData)) as { challenge?: unknown };
    if (typeof parsed.challenge !== "string" || !challenges.consume(parsed.challenge, "assert")) return bad();
    const stored = lock.credential(v.id);
    if (!stored) return bad();
    const result = verifyGet({
      clientDataJSON: clientData,
      authenticatorData: fromB64u(String(v.authenticatorData)),
      signature: fromB64u(String(v.signature)),
      publicKey: stored.publicKey,
      storedCounter: stored.counter,
      origin: originOf(req, url),
      rpId: rpId(req, url),
      challenge: parsed.challenge,
    });
    if (!result.ok) return bad();
    if (result.counter !== null) await lock.updateCounter(v.id, result.counter);
    console.log("[bridge] webauthn: unlocked");
    return secure(
      new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": sessionCookie(lock.issue(), wantsSecureCookie(req, url)),
        },
      }),
    );
  } catch {
    return bad();
  }
}

export async function webauthnRegisterRoute(
  req: Request,
  url: URL,
  cfg: Config,
  lock: LockStore,
  challenges: Challenges,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const denied = guard(req, cfg, "write");
  if (denied) return denied;
  if (lock.enabled() && !lock.valid(readCookie(req.headers.get("cookie"), LOCK_COOKIE))) return bad();
  const typed = requireJsonBody(req);
  if (typed) return typed;
  const v = await body(req);
  try {
    const clientData = fromB64u(String(v.clientDataJSON));
    const parsed = JSON.parse(new TextDecoder().decode(clientData)) as { challenge?: unknown };
    if (typeof parsed.challenge !== "string" || !challenges.consume(parsed.challenge, "register")) return bad(400);
    const result = verifyCreate({
      clientDataJSON: clientData,
      attestationObject: fromB64u(String(v.attestationObject)),
      origin: originOf(req, url),
      rpId: rpId(req, url),
      challenge: parsed.challenge,
    });
    if (!result.ok || v.id !== b64u(result.credentialId)) {
      audit.record({ action: "webauthn.register", detail: { passed: false, reason: "verification failed" } });
      return bad(400);
    }
    if (lock.credential(String(v.id))) return text("duplicate", 409);
    const name =
      typeof v.name === "string"
        ? v.name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 32) || "This browser"
        : "This browser";
    await lock.addCredential({ id: String(v.id), publicKey: result.publicKey, counter: result.counter, name });
    audit.record({ action: "webauthn.register", detail: { passed: true, name } });
    console.log(`[bridge] webauthn: registered ${name}`);
    return json({ ok: true }, null);
  } catch {
    return bad(400);
  }
}

export async function webauthnRemoveRoute(
  req: Request,
  url: URL,
  cfg: Config,
  lock: LockStore,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const denied = guard(req, cfg, "write");
  if (denied) return denied;
  if (lock.enabled() && !lock.valid(readCookie(req.headers.get("cookie"), LOCK_COOKIE))) return bad();
  const typed = requireJsonBody(req);
  if (typed) return typed;
  const v = await body(req);
  if (typeof v.id !== "string") return text("bad credential", 400);
  await lock.removeCredential(v.id);
  audit.record({ action: "webauthn.remove", detail: { passed: true, credentialId: v.id } });
  console.log("[bridge] webauthn: removed");
  return secure(
    new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        ...(lock.enabled() ? {} : { "set-cookie": clearedCookie(wantsSecureCookie(req, url)) }),
      },
    }),
  );
}
