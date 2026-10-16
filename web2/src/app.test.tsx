import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

describe("lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "PublicKeyCredential");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  });

  it("renders the unlock prompt when the bridge is locked, and no stream opens", async () => {
    server.use(http.get("/api/lock", () => HttpResponse.json({ enabled: true, unlocked: false, webauthn: true })));
    renderApp("/v2/");
    expect(await screen.findByRole("heading", { name: "Sightr is locked" })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("opens the shell after a device unlock", async () => {
    setViewportWidth(1280);
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: function PublicKeyCredential() {} });
    const buf = new Uint8Array([1, 2, 3]).buffer;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: vi.fn(async () => ({
          id: "cred-1",
          response: { clientDataJSON: buf, authenticatorData: buf, signature: buf },
        })),
      },
    });
    server.use(
      http.get("/api/lock", () => HttpResponse.json({ enabled: true, unlocked: false, webauthn: true, allowCredentials: [] })),
      http.post("/api/lock/webauthn/challenge", () =>
        HttpResponse.json({ challenge: "AQID", rpId: "localhost", rpName: "Sightr", userId: "u", allowCredentials: ["AQID"], timeout: 1000 }),
      ),
      http.post("/api/lock/webauthn/unlock", () => HttpResponse.json({ ok: true })),
    );
    renderApp("/v2/");
    fireEvent.click(await screen.findByRole("button", { name: "Unlock with this device" }));
    expect(await screen.findByText("Pick a thread")).toBeInTheDocument();
    await waitFor(() => expect(shellSource()).toBeDefined());
  });
});

describe("herdr floor", () => {
  it("shows the full-screen state with a link to v1, and leaves it when the bridge answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setViewportWidth(1280);
      server.use(
        http.get("/api/v2/shell", () =>
          HttpResponse.json(
            { ok: false, code: "herdr-too-old", error: "v2 needs herdr >= 0.9.0 (found 0.8.2)", have: "0.8.2", need: "0.9.0" },
            { status: 503 },
          ),
        ),
      );
      renderApp("/v2/");
      await waitFor(() => expect(shellSource()).toBeDefined());
      frame(() => shellSource()?.fail());
      expect(
        await screen.findByRole("heading", { name: "Sightr v2 needs herdr 0.9.0 or newer. This host runs 0.8.2." }),
      ).toBeInTheDocument();
      expect(screen.getByText("v2 needs herdr >= 0.9.0 (found 0.8.2)")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Sightr v1" })).toHaveAttribute("href", "/");

      // A minute later it tries again; this time the bridge streams.
      const before = FakeEventSource.instances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      await waitFor(() => expect(FakeEventSource.instances.length).toBe(before + 1));
      frame(() => FakeEventSource.latest().emit("snapshot", shellSnapshot(1, [])));
      expect(await screen.findByText("Pick a thread")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("connection banner", () => {
  it("is quiet while live, says reconnecting after 4 s, and offers Retry after 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setViewportWidth(1280);
      renderApp("/v2/");
      await waitFor(() => expect(shellSource()).toBeDefined());
      frame(() => shellSource()?.emit("snapshot", shellSnapshot(1, [])));
      expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
      frame(() => shellSource()?.fail());
      await vi.advanceTimersByTimeAsync(4_100);
      expect(await screen.findByText("Reconnecting…")).toBeInTheDocument();
      // Keep every reconnect failing.
      for (let i = 0; i < 6; i++) {
        frame(() => FakeEventSource.latest().fail());
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
      const before = FakeEventSource.instances.length;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(FakeEventSource.instances.length).toBe(before + 1);
      frame(() => FakeEventSource.latest().emit("ping", { sequence: 1 }));
      await waitFor(() => expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});
