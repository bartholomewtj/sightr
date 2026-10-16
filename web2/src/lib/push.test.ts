import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakePush, makeRegistration, subscribeExisting, uninstallFakePush, VAPID, type FakePush } from "@/test/push";
import { server } from "@/test/setup";

import {
  disablePush,
  enablePush,
  ENDPOINT_KEY,
  getPushState,
  isPushDisabledByUser,
  reattachPush,
  subscribeBody,
} from "./push";

let subscribed: Record<string, unknown>[] = [];
let fake: FakePush;

beforeEach(() => {
  subscribed = [];
  server.use(
    http.get("/api/config", () => HttpResponse.json({ push: true, vapidPublicKey: VAPID })),
    http.post("/api/subscribe", async ({ request }) => {
      subscribed.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
  );
  // As the build: web2's worker is /v2/sw.js with scope /v2/ (vite `base`).
  vi.stubEnv("BASE_URL", "/v2/");
  fake = installFakePush();
});

afterEach(() => {
  uninstallFakePush();
  vi.unstubAllEnvs();
});

describe("enablePush (web2's worker)", () => {
  it("subscribes through web2's registration and names the v1 endpoint it replaces", async () => {
    localStorage.setItem(ENDPOINT_KEY, "https://push.example/v1-endpoint");
    const res = await enablePush();
    expect(res).toEqual({ ok: true });
    expect(fake.register).toHaveBeenCalledWith("/v2/sw.js", { scope: "/v2/" });
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(subscribed).toHaveLength(1);
    const body = subscribed[0]!;
    expect(body.endpoint).toMatch(/^https:\/\/push\.example\//);
    expect(body.endpoint).not.toBe("https://push.example/v1-endpoint");
    expect(body.replaces).toBe("https://push.example/v1-endpoint");
    expect(body.keys).toEqual({ p256dh: "p", auth: "a" });
    // The next subscribe from this device supersedes web2's endpoint, not v1's.
    expect(localStorage.getItem(ENDPOINT_KEY)).toBe(body.endpoint);
  });

  it("sends no `replaces` when the device had no endpoint, or the same one", () => {
    const json = { endpoint: "e1", keys: { p256dh: "p", auth: "a" } };
    expect(subscribeBody(json, null)).not.toHaveProperty("replaces");
    expect(subscribeBody(json, "e1")).not.toHaveProperty("replaces");
    expect(subscribeBody(json, "e0")).toMatchObject({ replaces: "e0" });
  });

  it("reports why it could not subscribe", async () => {
    server.use(http.post("/api/subscribe", () => new HttpResponse(null, { status: 403 })));
    expect(await enablePush()).toEqual({ ok: false, reason: "refused" });

    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })));
    expect(await enablePush()).toEqual({ ok: false, reason: "server-off" });

    fake.setPermission("denied");
    server.use(http.get("/api/config", () => HttpResponse.json({ push: true, vapidPublicKey: VAPID })));
    expect(await enablePush()).toEqual({ ok: false, reason: "denied" });
  });

  it("is unsupported without the Push API and insecure over plain HTTP", async () => {
    uninstallFakePush();
    expect(await enablePush()).toEqual({ ok: false, reason: "unsupported" });
    installFakePush({ secure: false });
    expect(await enablePush()).toEqual({ ok: false, reason: "insecure" });
  });
});

describe("reading and clearing web2's subscription", () => {
  it("never reads or unsubscribes v1's worker, whose scope also covers /v2/", async () => {
    const v1 = makeRegistration("/");
    subscribeExisting(v1, "https://push.example/v1-endpoint");
    fake.registrations.set("/", v1);
    localStorage.setItem(ENDPOINT_KEY, "https://push.example/v1-endpoint");
    expect((await getPushState()).subscribed).toBe(false);
    await disablePush();
    expect(v1.sub).not.toBeNull();
  });

  it("disablePush unsubscribes and remembers the choice", async () => {
    await enablePush();
    const reg = fake.registrations.get("/v2/")!;
    const sub = reg.sub!;
    await disablePush();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(isPushDisabledByUser()).toBe(true);
    expect(localStorage.getItem(ENDPOINT_KEY)).toBeNull();
    const state = await getPushState();
    expect(state).toEqual({ availability: "ready", subscribed: false, userDisabled: true });
  });
});

describe("reattachPush (boot)", () => {
  it("leaves a device alone that never turned push on in web2", async () => {
    fake.setPermission("granted");
    localStorage.setItem(ENDPOINT_KEY, "https://push.example/v1-endpoint");
    expect(await reattachPush()).toEqual({ skipped: true });
    expect(subscribed).toHaveLength(0);
  });

  it("skips when web2's subscription is the one the bridge has", async () => {
    fake.setPermission("granted");
    await enablePush();
    subscribed = [];
    expect(await reattachPush()).toEqual({ skipped: true });
    expect(subscribed).toHaveLength(0);
  });

  it("re-registers web2's subscription after another UI took the device's push", async () => {
    fake.setPermission("granted");
    await enablePush();
    const mine = subscribed[0]!.endpoint;
    localStorage.setItem(ENDPOINT_KEY, "https://push.example/v1-again");
    subscribed = [];
    const res = await reattachPush();
    expect(res).toEqual({ skipped: false, result: { ok: true } });
    expect(subscribed).toEqual([expect.objectContaining({ endpoint: mine, replaces: "https://push.example/v1-again" })]);
  });
});
