import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PUSH_HOSTS,
  hostAllowedForPush,
  looksPrivateHost,
  MAX_SUBSCRIPTIONS,
  parsePushSubscription,
  PUSH_ENDPOINT_MAX,
  validPushEndpoint,
  validPushKey,
} from "./push-endpoint.ts";

const VALID_P256DH = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"; // 65 bytes
const VALID_AUTH = "AgICAgICAgICAgICAgICAg"; // 16 bytes

describe("push-endpoint constants", () => {
  test("PUSH_ENDPOINT_MAX is 2048 and MAX_SUBSCRIPTIONS is 20", () => {
    expect(PUSH_ENDPOINT_MAX).toBe(2048);
    expect(MAX_SUBSCRIPTIONS).toBe(20);
  });

  test("DEFAULT_PUSH_HOSTS includes all major push service families", () => {
    expect(DEFAULT_PUSH_HOSTS).toContain("fcm.googleapis.com");
    expect(DEFAULT_PUSH_HOSTS).toContain("android.googleapis.com");
    expect(DEFAULT_PUSH_HOSTS).toContain("push.services.mozilla.com");
    expect(DEFAULT_PUSH_HOSTS).toContain("push.apple.com");
    expect(DEFAULT_PUSH_HOSTS).toContain("notify.windows.com");
    expect(DEFAULT_PUSH_HOSTS).toContain("push.services.microsoft.com");
  });
});

describe("hostAllowedForPush", () => {
  test("matches exact default hosts and dot-prefixes", () => {
    expect(hostAllowedForPush("fcm.googleapis.com")).toBe(true);
    expect(hostAllowedForPush("android.googleapis.com")).toBe(true);
    expect(hostAllowedForPush("updates.push.services.mozilla.com")).toBe(true);
    expect(hostAllowedForPush("web.push.apple.com")).toBe(true);
    expect(hostAllowedForPush("db5p.notify.windows.com")).toBe(true);
    expect(hostAllowedForPush("region.push.services.microsoft.com")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(hostAllowedForPush("FCM.GOOGLEAPIS.COM")).toBe(true);
    expect(hostAllowedForPush("Web.Push.Apple.COM")).toBe(true);
  });

  test("honours extra operator-configured allowed hosts", () => {
    expect(hostAllowedForPush("push.custom.org", ["push.custom.org"])).toBe(true);
    expect(hostAllowedForPush("sub.push.custom.org", ["push.custom.org"])).toBe(true);
    expect(hostAllowedForPush("push.custom.org", [])).toBe(false);
  });

  test("rejects unlisted hosts", () => {
    expect(hostAllowedForPush("evil.example.com")).toBe(false);
    expect(hostAllowedForPush("10.0.0.5")).toBe(false);
    expect(hostAllowedForPush("")).toBe(false);
  });

  test("rejects suffix attacks that do not match on a dot boundary", () => {
    expect(hostAllowedForPush("fcm.googleapis.com.evil.com")).toBe(false);
    expect(hostAllowedForPush("notfcm.googleapis.com")).toBe(false);
    expect(hostAllowedForPush("fake-push.apple.com.attacker.com")).toBe(false);
  });
});

describe("looksPrivateHost", () => {
  test("returns true for localhost, special IPs, and local domains", () => {
    expect(looksPrivateHost("localhost")).toBe(true);
    expect(looksPrivateHost("10.0.0.5")).toBe(true);
    expect(looksPrivateHost("192.168.1.1")).toBe(true);
    expect(looksPrivateHost("172.20.0.1")).toBe(true);
    expect(looksPrivateHost("169.254.1.1")).toBe(true);
    expect(looksPrivateHost("100.64.0.1")).toBe(true);
    expect(looksPrivateHost("[::1]")).toBe(true);
    expect(looksPrivateHost("::1")).toBe(true);
    expect(looksPrivateHost("0.0.0.0")).toBe(true);
    expect(looksPrivateHost("box.local")).toBe(true);
    expect(looksPrivateHost("app.internal")).toBe(true);
    expect(looksPrivateHost("router.home.arpa")).toBe(true);
    expect(looksPrivateHost("nodot")).toBe(true);
  });

  test("returns false for public domains and public IPs", () => {
    expect(looksPrivateHost("fcm.googleapis.com")).toBe(false);
    expect(looksPrivateHost("push.apple.com")).toBe(false);
    expect(looksPrivateHost("8.8.8.8")).toBe(false);
    expect(looksPrivateHost("1.1.1.1")).toBe(false);
    expect(looksPrivateHost("172.15.0.1")).toBe(false);
    expect(looksPrivateHost("172.32.0.1")).toBe(false);
    expect(looksPrivateHost("100.128.0.1")).toBe(false);
  });
});

describe("validPushKey", () => {
  test("validates exact byte lengths for p256dh (65 bytes)", () => {
    expect(validPushKey(VALID_P256DH, 65, true)).toBe(true);
    expect(validPushKey("p", 65, true)).toBe(false);
    const byte64 = Buffer.alloc(64, 1).toString("base64url");
    expect(validPushKey(byte64, 65, true)).toBe(false);
    const byte66 = Buffer.alloc(66, 1).toString("base64url");
    expect(validPushKey(byte66, 65, true)).toBe(false);
  });

  test("validates minimum byte lengths for auth (at least 16 bytes)", () => {
    expect(validPushKey(VALID_AUTH, 16, false)).toBe(true);
    expect(validPushKey("a", 16, false)).toBe(false);
    const byte15 = Buffer.alloc(15, 1).toString("base64url");
    expect(validPushKey(byte15, 16, false)).toBe(false);
    const byte32 = Buffer.alloc(32, 1).toString("base64url");
    expect(validPushKey(byte32, 16, false)).toBe(true);
  });

  test("accepts padded base64 and standard base64 alphabet", () => {
    const std65 = Buffer.alloc(65, 255).toString("base64");
    expect(validPushKey(std65, 65, true)).toBe(true);
    const std16 = Buffer.alloc(16, 255).toString("base64");
    expect(validPushKey(std16, 16, false)).toBe(true);
  });

  test("rejects invalid characters and empty strings", () => {
    expect(validPushKey("", 16, false)).toBe(false);
    expect(validPushKey("invalid!chars$", 16, false)).toBe(false);
    expect(validPushKey("   ", 16, false)).toBe(false);
  });
});

describe("validPushEndpoint", () => {
  test("accepts valid HTTPS endpoints on allowlisted hosts", () => {
    expect(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
    expect(validPushEndpoint("https://web.push.apple.com/send/xyz")).toBe(true);
    expect(validPushEndpoint("https://db5p.notify.windows.com/w/?token=abc")).toBe(true);
    expect(validPushEndpoint("https://push.custom.org:8443/sub", ["push.custom.org"])).toBe(true);
  });

  test("rejects the exploit from issue #7 verbatim", () => {
    expect(validPushEndpoint("https://10.0.0.5:8443/admin/x")).toBe(false);
  });

  test("rejects non-https schemes", () => {
    expect(validPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(validPushEndpoint("file:///etc/passwd")).toBe(false);
    expect(validPushEndpoint("ftp://fcm.googleapis.com/send")).toBe(false);
  });

  test("rejects non-allowlisted hosts", () => {
    expect(validPushEndpoint("https://evil.example.com/send")).toBe(false);
    expect(validPushEndpoint("https://fcm.googleapis.com.evil.com/send")).toBe(false);
  });

  test("rejects URLs with credentials", () => {
    expect(validPushEndpoint("https://user:pw@fcm.googleapis.com/send")).toBe(false);
    expect(validPushEndpoint("https://user@fcm.googleapis.com/send")).toBe(false);
  });

  test("rejects endpoints over PUSH_ENDPOINT_MAX characters", () => {
    const long = "https://fcm.googleapis.com/" + "a".repeat(2050);
    expect(validPushEndpoint(long)).toBe(false);
  });

  test("rejects malformed URLs", () => {
    expect(validPushEndpoint("not-a-url")).toBe(false);
    expect(validPushEndpoint("")).toBe(false);
  });
});

describe("parsePushSubscription", () => {
  test("accepts a conforming subscription and returns a fresh object", () => {
    const raw = {
      endpoint: "https://fcm.googleapis.com/fcm/send/token123",
      keys: {
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
      },
      extraProperty: "attacker_payload",
      evil: 1,
    };
    const parsed = parsePushSubscription(raw);
    expect(parsed).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/token123",
      keys: {
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
      },
    });
    // Unknown fields must be stripped
    expect("extraProperty" in (parsed as Record<string, unknown>)).toBe(false);
    expect("evil" in (parsed as Record<string, unknown>)).toBe(false);
  });

  test("rejects invalid shapes, missing keys, or bad values", () => {
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription({})).toBeNull();
    expect(parsePushSubscription("string")).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: "https://fcm.googleapis.com/send",
        keys: { p256dh: "p", auth: "a" },
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: "https://10.0.0.5:8443/admin/x",
        keys: { p256dh: VALID_P256DH, auth: VALID_AUTH },
      }),
    ).toBeNull();
  });
});
