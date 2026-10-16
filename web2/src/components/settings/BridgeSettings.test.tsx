import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeSettingsView } from "@shared/wire";
import { useBridgeInfo, useStreamHealth } from "@/stream/stores";
import { server } from "@/test/setup";

import { BridgeSettings } from "./BridgeSettings";
import { ConnectionInfo } from "./ConnectionInfo";

const ENV = { deviceAllowlist: ["phone"], notifyDelayMs: 30_000, submitKeys: ["Enter"], readLines: 200 };
let view: BridgeSettingsView;
let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  view = { ...ENV, overridden: [], defaults: ENV };
  posts = [];
  server.use(
    http.get("/api/settings", () => HttpResponse.json(view)),
    http.post("/api/settings", async ({ request }) => {
      const patch = (await request.json()) as Record<string, unknown>;
      posts.push(patch);
      if (Array.isArray(patch.reset)) view = { ...view, ...ENV, overridden: [] };
      else view = { ...view, ...patch, overridden: Object.keys(patch) as BridgeSettingsView["overridden"] };
      return HttpResponse.json(view);
    }),
  );
});

describe("BridgeSettings", () => {
  it("loads the bridge's values, saves a change (delay in seconds, wire in ms) and can go back to .env", async () => {
    render(<BridgeSettings />);
    const delay = (await screen.findByLabelText("Notify delay (seconds)")) as HTMLInputElement;
    await waitFor(() => expect(delay.value).toBe("30"));
    expect(screen.getByTestId("source-notifyDelayMs")).toHaveTextContent("From .env");
    fireEvent.change(delay, { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toEqual([{ notifyDelayMs: 12_500 }]));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.getByTestId("source-notifyDelayMs")).toHaveTextContent("Set here · .env is 30 s");
    fireEvent.click(screen.getByRole("button", { name: "Use .env" }));
    await waitFor(() => expect(posts[1]).toEqual({ reset: ["notifyDelayMs"] }));
    await waitFor(() => expect(delay.value).toBe("30"));
  });

  it("asks twice before dropping this device from the allowlist", async () => {
    render(<BridgeSettings device={{ enforced: true, device: "phone", authorized: true }} />);
    const allow = (await screen.findByLabelText("Device allowlist")) as HTMLInputElement;
    await waitFor(() => expect(allow.value).toBe("phone"));
    fireEvent.change(allow, { target: { value: "laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This removes this device's access.");
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toEqual([{ deviceAllowlist: ["laptop"] }]));
  });

  it("read-only: values show, nothing can be saved", async () => {
    render(<BridgeSettings readOnly />);
    const lines = (await screen.findByLabelText("Read lines")) as HTMLInputElement;
    await waitFor(() => expect(lines.value).toBe("200"));
    expect(lines).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a save the bridge refuses names its reason", async () => {
    server.use(http.post("/api/settings", () => new HttpResponse("bad notifyDelayMs", { status: 400 })));
    render(<BridgeSettings />);
    const delay = (await screen.findByLabelText("Notify delay (seconds)")) as HTMLInputElement;
    await waitFor(() => expect(delay.value).toBe("30"));
    fireEvent.change(delay, { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save bridge settings: bad notifyDelayMs.");
  });

  it("a refused save says the device is read-only and puts the values back", async () => {
    server.use(http.post("/api/settings", () => new HttpResponse("device not authorised", { status: 403 })));
    render(<BridgeSettings />);
    const lines = (await screen.findByLabelText("Read lines")) as HTMLInputElement;
    await waitFor(() => expect(lines.value).toBe("200"));
    fireEvent.change(lines, { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Read-only — this device isn't authorised to change bridge settings.");
    expect(lines.value).toBe("200");
  });
});

describe("ConnectionInfo", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("shows this web2 build, the build the bridge serves now, the link and this device's access", async () => {
    vi.stubEnv("BASE_URL", "/v2/");
    server.use(http.head("/v2/sw.js", () => new HttpResponse(null, { headers: { "x-sightr-build": "1.2.1+abc.99" } })));
    act(() => {
      useStreamHealth.setState({ status: "live" });
      useBridgeInfo.setState({ herdr: "connected", device: { enforced: true, device: "phone", authorized: false }, readOnly: true });
    });
    render(<ConnectionInfo />);
    // __BUILD_INFO__.id is "test" under Vitest (vitest.config.ts).
    expect(screen.getByText("This build").nextElementSibling).toHaveTextContent("test");
    expect(screen.getByText("Bridge").nextElementSibling).toHaveTextContent("Connected");
    expect(screen.getByText("Device access").nextElementSibling).toHaveTextContent("Read-only · phone");
    await waitFor(() => expect(screen.getByText("Server build").nextElementSibling).toHaveTextContent("1.2.1+abc.99"));
  });
});
