import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import {
  enablePush,
  dismissPushOnboarding,
  getPushDevice,
  isPushDisabledByUser,
  isPushOnboarded,
  needsHomeScreenInstall,
  IOS_INSTALL_NOTE,
  pushFailureText,
  pushOnboardingCard,
  pushOnboardingDismissed,
  PUSH_DISMISS_MS,
  reattachPush,
  keysMatch,
  markPushOnboarded,
  notePushDevice,
  resetPushDevice,
  subscribeBody,
} from "./push";

// The VAPID-rotation guard in enablePush hinges on this byte compare: an existing PushManager
// subscription is bound to the applicationServerKey it was created with, so when the server rotates
// its VAPID keypair we must notice the mismatch and re-subscribe. (enablePush itself needs a real
// PushManager, which jsdom lacks, so we pin the pure compare here.)
const bufOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe("push onboarding", () => {
  beforeEach(() => { resetPushDevice(); localStorage.clear(); });

  const base = {
    seen: true,
    readOnly: false,
    availability: "ready" as const,
    userDisabled: false,
    permission: "default" as NotificationPermission,
    onboarded: false,
  };

  it("selects enable, install, or no onboarding card", () => {
    expect(pushOnboardingCard({ ...base, dismissed: false, iosInstall: false })).toBe("enable");
    for (const input of [
      { seen: false }, { readOnly: true }, { onboarded: true }, { dismissed: true },
      { userDisabled: true }, { permission: "granted" as const }, { availability: "denied" as const },
    ]) expect(pushOnboardingCard({ ...base, dismissed: false, iosInstall: false, ...input })).toBeNull();
    expect(pushOnboardingCard({ ...base, availability: "unsupported", dismissed: false, iosInstall: true })).toBe("install");
    expect(pushOnboardingCard({ ...base, availability: "unsupported", dismissed: false, iosInstall: false })).toBeNull();
  });

  it("holds dismissal for seven days, but not at the boundary", () => {
    const now = 1_000_000;
    expect(pushOnboardingDismissed(now)).toBe(false);
    dismissPushOnboarding(now);
    expect(pushOnboardingDismissed(now + PUSH_DISMISS_MS - 1)).toBe(true);
    expect(pushOnboardingDismissed(now + PUSH_DISMISS_MS)).toBe(false);
    localStorage.setItem("sightr:push-onboarding:dismissed-at", "junk");
    expect(pushOnboardingDismissed(now)).toBe(false);
  });

  it("detects installed and non-installed iOS separately", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "iPhone Safari" });
    expect(needsHomeScreenInstall()).toBe(true);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    expect(needsHomeScreenInstall()).toBe(false);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Chrome desktop" });
    expect(needsHomeScreenInstall()).toBe(false);
    Reflect.deleteProperty(navigator, "standalone");
  });

  it("uses the iOS install note only for an iOS unsupported browser", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "iPhone Safari" });
    expect(pushFailureText("unsupported")).toBe(IOS_INSTALL_NOTE);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Chrome desktop" });
    expect(pushFailureText("unsupported")).toBe("This browser doesn't support push notifications.");
  });

  it("remembers onboarding without disabling push", () => {
    expect(isPushOnboarded()).toBe(false);
    markPushOnboarded();
    expect(isPushOnboarded()).toBe(true);
    expect(isPushDisabledByUser()).toBe(false);
    expect(localStorage.getItem("sightr:push-disabled")).toBeNull();
  });

  it("tracks whether the snapshot device is read-only with stable identity", () => {
    notePushDevice({ enforced: true, device: "phone", authorized: false });
    const first = getPushDevice();
    expect(first).toEqual({ seen: true, readOnly: true });
    notePushDevice({ enforced: true, device: "phone", authorized: false });
    expect(getPushDevice()).toBe(first);
    resetPushDevice();
    notePushDevice(undefined);
    expect(getPushDevice()).toEqual({ seen: true, readOnly: false });
  });
});

describe("keysMatch", () => {
  it("is true when the existing key's bytes equal the server key", () => {
    expect(keysMatch(bufOf([1, 2, 3, 4]), new Uint8Array([1, 2, 3, 4]))).toBe(true);
  });

  it("is false when the bytes differ", () => {
    expect(keysMatch(bufOf([1, 2, 3, 4]), new Uint8Array([1, 2, 9, 4]))).toBe(false);
  });

  it("is false when the lengths differ", () => {
    expect(keysMatch(bufOf([1, 2, 3]), new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it("is false when there is no existing key (null / undefined)", () => {
    const server = new Uint8Array([1, 2, 3]);
    expect(keysMatch(null, server)).toBe(false);
    expect(keysMatch(undefined, server)).toBe(false);
  });
});

// The body `/api/subscribe` receives. A service worker re-registration mints a NEW endpoint and
// abandons the old one without unsubscribing it, so the push service keeps accepting sends to a row
// nobody reads (collie#104). Only this device knows the two endpoints are the same phone — `replaces`
// is how it says so, and the remembered endpoint is the whole of its memory.
describe("subscribeBody", () => {
  const json = { endpoint: "https://push/new", keys: { p256dh: "P", auth: "A" } };

  it("carries exactly endpoint + keys when this device has registered nothing before", () => {
    expect(subscribeBody(json, null)).toEqual({
      endpoint: "https://push/new",
      keys: { p256dh: "P", auth: "A" },
    });
  });

  it("supersedes the endpoint this device last registered", () => {
    expect(subscribeBody(json, "https://push/old")).toEqual({
      endpoint: "https://push/new",
      keys: { p256dh: "P", auth: "A" },
      replaces: "https://push/old",
    });
  });

  it("does not claim to supersede ITSELF — a re-register of the same endpoint replaces nothing", () => {
    expect(subscribeBody(json, "https://push/new").replaces).toBeUndefined();
  });

  it("ignores an empty remembered endpoint", () => {
    expect(subscribeBody(json, "").replaces).toBeUndefined();
  });

  it("never forwards a field the browser happened to put on the subscription", () => {
    const extra = { ...json, expirationTime: 123, junk: "x" } as PushSubscriptionJSON;
    expect(Object.keys(subscribeBody(extra, null)).sort()).toEqual(["endpoint", "keys"]);
  });
});

describe("reattachPush", () => {
  it("skips when the live endpoint is already registered", async () => {
    localStorage.setItem("sightr:push-endpoint", "https://push.example/abc");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/abc" }) } }),
    }});
    await expect(reattachPush()).resolves.toEqual({ skipped: true });
  });

  it("does not skip when the endpoint differs", async () => {
    localStorage.setItem("sightr:push-endpoint", "https://push.example/abc");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/other" }) } }),
    }});
    Reflect.deleteProperty(window, "PushManager");
    await expect(reattachPush()).resolves.toEqual({ skipped: false, result: { ok: false, reason: "unsupported" } });
  });
});

describe("enablePush", () => {
  beforeEach(() => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(window, "PushManager", { value: class PushManager {}, configurable: true });
    Object.defineProperty(window, "Notification", {
      value: {
        permission: "granted",
        requestPermission: vi.fn().mockResolvedValue("granted"),
      },
      configurable: true,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: vi.fn().mockResolvedValue({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue(null),
            subscribe: vi.fn().mockResolvedValue({
              toJSON: () => ({
                endpoint: "https://push/ep-test",
                keys: { p256dh: "P", auth: "A" },
              }),
            }),
          },
        }),
      },
      configurable: true,
    });

    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: true,
          vapidPublicKey: "AQIDBA",
        }),
      ),
    );
  });

  it("returns refused on 403, does not remember endpoint, and does not clear user-disabled", async () => {
    localStorage.setItem("sightr:push-disabled", "1");
    server.use(http.post("/api/subscribe", () => new HttpResponse(null, { status: 403 })));

    const result = await enablePush();
    expect(result).toEqual({ ok: false, reason: "refused" });
    expect(localStorage.getItem("sightr:push-endpoint")).toBeNull();
    expect(isPushDisabledByUser()).toBe(true);
  });

  it("returns ok on success, remembers endpoint, and clears user-disabled", async () => {
    localStorage.setItem("sightr:push-disabled", "1");
    server.use(http.post("/api/subscribe", () => new HttpResponse(null, { status: 204 })));

    const result = await enablePush();
    expect(result).toEqual({ ok: true });
    expect(localStorage.getItem("sightr:push-endpoint")).toBe("https://push/ep-test");
    expect(isPushDisabledByUser()).toBe(false);
  });
});
