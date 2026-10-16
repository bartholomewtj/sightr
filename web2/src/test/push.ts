/**
 * A fake Push stack for jsdom: `navigator.serviceWorker` with registrations by scope, a `PushManager`
 * that mints endpoints, and `Notification` with a settable permission. `install()` returns handles to
 * inspect; `uninstall()` removes every global it added.
 */
import { vi } from "vitest";

export interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe: ReturnType<typeof vi.fn>;
}

export interface FakeRegistration {
  scope: string;
  pushManager: {
    getSubscription: () => Promise<FakeSubscription | null>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  sub: FakeSubscription | null;
}

/** The VAPID key the fake bridge hands out (base64url of bytes 1..4). */
export const VAPID = "AQIDBA";
const VAPID_BYTES = new Uint8Array([1, 2, 3, 4]).buffer;

let added: string[] = [];
let minted = 0;

function subscription(reg: FakeRegistration, endpoint: string, key: ArrayBuffer | null = VAPID_BYTES): FakeSubscription {
  const sub: FakeSubscription = {
    endpoint,
    options: { applicationServerKey: key },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => {
      if (reg.sub === sub) reg.sub = null;
      return true;
    }),
  };
  return sub;
}

export function makeRegistration(scopePath: string): FakeRegistration {
  const reg: FakeRegistration = {
    scope: new URL(scopePath, window.location.href).href,
    sub: null,
    pushManager: {
      getSubscription: async () => reg.sub,
      subscribe: vi.fn(async () => {
        reg.sub = subscription(reg, `https://push.example/${scopePath.replace(/\//g, "_")}-${++minted}`);
        return reg.sub;
      }),
    },
  };
  return reg;
}

/** Give a registration an existing subscription. */
export function subscribeExisting(reg: FakeRegistration, endpoint: string): FakeSubscription {
  reg.sub = subscription(reg, endpoint);
  return reg.sub;
}

export interface FakePush {
  registrations: Map<string, FakeRegistration>;
  register: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  setPermission(p: NotificationPermission): void;
}

function define(target: object, key: string, value: unknown, name: string): void {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  added.push(name);
}

/** Install the fake. `registrations` is keyed by scope path ("/", "/v2/"); lookups pick the longest match. */
export function installFakePush({ permission = "default" as NotificationPermission, secure = true } = {}): FakePush {
  const registrations = new Map<string, FakeRegistration>();
  let current = permission;
  const requestPermission = vi.fn(async () => {
    current = "granted";
    return current;
  });
  const register = vi.fn(async (_url: string, opts?: { scope?: string }) => {
    const scope = opts?.scope ?? "/";
    const reg = registrations.get(scope) ?? makeRegistration(scope);
    registrations.set(scope, reg);
    return reg;
  });
  const getRegistration = async (clientUrl = "/") => {
    const path = new URL(clientUrl, window.location.href).pathname;
    const match = [...registrations.keys()].filter((s) => path.startsWith(s)).sort((a, b) => b.length - a.length)[0];
    return match ? registrations.get(match) : undefined;
  };
  define(navigator, "serviceWorker", { register, getRegistration }, "navigator.serviceWorker");
  define(window, "PushManager", class PushManager {}, "window.PushManager");
  define(
    window,
    "Notification",
    {
      get permission() {
        return current;
      },
      requestPermission,
    },
    "window.Notification",
  );
  define(window, "isSecureContext", secure, "window.isSecureContext");
  return { registrations, register, requestPermission, setPermission: (p) => (current = p) };
}

export function uninstallFakePush(): void {
  for (const name of added) {
    const [owner, key] = name.split(".") as [string, string];
    Reflect.deleteProperty(owner === "navigator" ? navigator : window, key);
  }
  added = [];
}
