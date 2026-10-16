import { describe, expect, it } from "vitest";

import { isNetworkOnlyNavigation, isOwnScope, isOwnWorker, isStaleV1FontEntry, NAVIGATION_NETWORK_ONLY } from "./sw-routes";

describe("web2 worker navigation denylist (T15)", () => {
  it("leaves /v1/, /api/ and /auth to the network", () => {
    for (const path of ["/v1", "/v1/", "/v1/pane/p1", "/v1?x=1", "/api/v2/shell", "/auth", "/auth/", "/auth?rd=%2F", "/cdn-cgi/access/login"]) {
      expect(isNetworkOnlyNavigation(path)).toBe(true);
    }
  });

  it("answers web2's own paths from the precache", () => {
    for (const path of ["/", "/thread/t1", "/pane/p1", "/settings", "/v1x", "/authors", "/files/a"]) {
      expect(isNetworkOnlyNavigation(path)).toBe(false);
    }
  });

  it("sends the old /v2/ address to the bridge's redirect when web2 lives at /", () => {
    expect(isNetworkOnlyNavigation("/v2/pane/p1")).toBe(true);
    expect(isNetworkOnlyNavigation("/v2")).toBe(true);
    expect(isNetworkOnlyNavigation("/v2x")).toBe(false);
    // A /v2/ preview build must still answer its own navigations.
    expect(isNetworkOnlyNavigation("/v2/thread/t1", "/v2/")).toBe(false);
  });

  it("keeps the API rule anchored", () => {
    expect(NAVIGATION_NETWORK_ONLY.some((re) => re.test("/x/api/"))).toBe(false);
  });
});

describe("inherited caches and registrations", () => {
  it("drops only the old v1's /fonts/ entries, never v1's /v1/fonts/", () => {
    expect(isStaleV1FontEntry("/fonts/nerd-symbols-3.5.0-pua.woff2")).toBe(true);
    expect(isStaleV1FontEntry("/v1/fonts/nerd-symbols-3.5.0-pua.woff2")).toBe(false);
  });

  it("tells web2's worker and scope from v1's", () => {
    expect(isOwnWorker("https://h/sw.js", "/")).toBe(true);
    expect(isOwnWorker("https://h/v1/sw.js", "/")).toBe(false);
    expect(isOwnWorker(undefined, "/")).toBe(false);
    expect(isOwnScope("https://h/", "/")).toBe(true);
    expect(isOwnScope("https://h/v1/", "/")).toBe(false);
  });
});
