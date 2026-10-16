import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LockCredential } from "@shared/wire";
import { server } from "@/test/setup";

import { LOCAL_CREDENTIAL_KEY, LockSettings } from "./LockSettings";

let credentials: LockCredential[] = [];
let enabled = false;
let registered: Record<string, unknown>[] = [];
let removed: string[] = [];
let cleared = 0;

const buf = new Uint8Array([1, 2, 3]).buffer;

beforeEach(() => {
  credentials = [];
  enabled = false;
  registered = [];
  removed = [];
  cleared = 0;
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: function PublicKeyCredential() {} });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      create: vi.fn(async () => ({
        id: "cred-new",
        response: { clientDataJSON: buf, attestationObject: buf, getAuthenticatorData: () => buf },
      })),
    },
  });
  server.use(
    http.get("/api/lock", () => HttpResponse.json({ enabled, unlocked: true, webauthn: true, credentials })),
    http.post("/api/lock/webauthn/challenge", () =>
      HttpResponse.json({ challenge: "AQID", rpId: "localhost", rpName: "Sightr", userId: "dQ", allowCredentials: [], timeout: 1000 }),
    ),
    http.post("/api/lock/webauthn/register", async ({ request }) => {
      const body = (await request.json()) as { id: string; name: string };
      registered.push(body);
      credentials = [...credentials, { id: body.id, name: body.name, addedAt: 1_700_000_000_000 }];
      enabled = true;
      return HttpResponse.json({ ok: true });
    }),
    http.post("/api/lock/webauthn/remove", async ({ request }) => {
      const { id } = (await request.json()) as { id: string };
      removed.push(id);
      credentials = credentials.filter((c) => c.id !== id);
      enabled = credentials.length > 0;
      return HttpResponse.json({ ok: true });
    }),
    http.post("/api/lock/clear-all", () => {
      cleared++;
      credentials = [];
      enabled = false;
      return HttpResponse.json({ ok: true });
    }),
  );
});

afterEach(() => {
  Reflect.deleteProperty(window, "PublicKeyCredential");
  Reflect.deleteProperty(navigator, "credentials");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
});

describe("LockSettings", () => {
  it("registers this device with WebAuthn, then lists it and can remove it", async () => {
    render(<LockSettings readOnly={false} />);
    expect(await screen.findByText(/Off — anyone who can reach Sightr/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add this device" }));
    await waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0]).toMatchObject({ id: "cred-new", clientDataJSON: "AQID", attestationObject: "AQID" });
    expect(localStorage.getItem(LOCAL_CREDENTIAL_KEY)).toBe("cred-new");
    expect(await screen.findByText(/On — asked after a bridge restart/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove this device" }));
    await waitFor(() => expect(removed).toEqual(["cred-new"]));
    expect(localStorage.getItem(LOCAL_CREDENTIAL_KEY)).toBeNull();
  });

  it("lists the other devices and removes one", async () => {
    enabled = true;
    credentials = [
      { id: "c1", name: "iPhone", addedAt: 1_700_000_000_000 },
      { id: "c2", name: "Windows", addedAt: 1_700_000_000_000 },
    ];
    render(<LockSettings readOnly={false} />);
    const iphone = (await screen.findByText("iPhone")).closest("[data-lock-device]") as HTMLElement;
    expect(screen.getByText("Windows")).toBeInTheDocument();
    fireEvent.click(within(iphone).getByRole("button", { name: "Remove iPhone" }));
    await waitFor(() => expect(removed).toEqual(["c1"]));
    await waitFor(() => expect(screen.queryByText("iPhone")).toBeNull());
  });

  it("turning the lock off takes a second tap", async () => {
    enabled = true;
    credentials = [{ id: "c1", name: "iPhone", addedAt: 1 }];
    render(<LockSettings readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off reconnect lock" }));
    expect(cleared).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(cleared).toBe(1));
  });

  it("forgets this device's id when the bridge no longer lists it", async () => {
    localStorage.setItem(LOCAL_CREDENTIAL_KEY, "gone");
    render(<LockSettings readOnly={false} />);
    await screen.findByText(/Off — anyone/);
    await waitFor(() => expect(localStorage.getItem(LOCAL_CREDENTIAL_KEY)).toBeNull());
  });

  it("read-only: the list shows, the controls do not", async () => {
    enabled = true;
    credentials = [{ id: "c1", name: "iPhone", addedAt: 1 }];
    render(<LockSettings readOnly />);
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText("This device isn't authorised to change settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
