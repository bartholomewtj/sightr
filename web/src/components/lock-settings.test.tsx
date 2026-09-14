import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LockSettings } from "./lock-settings";
import { clearLock, fetchLockStatus } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchLockStatus: vi.fn(),
  clearLock: vi.fn(),
  registerWebauthn: vi.fn(),
  removeWebauthn: vi.fn(),
  webauthnChallenge: vi.fn(),
  b64uToBytes: vi.fn(() => new Uint8Array(4)),
  bytesToB64u: vi.fn(() => "AAAA"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "PublicKeyCredential", { value: function () {}, configurable: true });
  Object.defineProperty(navigator, "credentials", { value: { get: vi.fn(), create: vi.fn() }, configurable: true });
  vi.mocked(fetchLockStatus).mockResolvedValue({ enabled: false, unlocked: true, webauthn: false, credentials: [] });
});

describe("LockSettings", () => {
  it("shows heading and Add this device only in a secure context", async () => {
    render(<LockSettings readOnly={false} />);
    await waitFor(() => expect(screen.getByText("Reconnect lock")).toBeInTheDocument());
    expect(screen.getByText("Add this device")).toBeInTheDocument();
    expect(screen.queryByText("Lock store was unreadable and has been set aside — register a device again.")).toBeNull();
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<LockSettings readOnly={false} />);
    await waitFor(() => expect(screen.getAllByText("Device unlock needs HTTPS.").length).toBeGreaterThan(0));
  });

  it("shows a loud warning when the lock store is corrupt", async () => {
    vi.mocked(fetchLockStatus).mockResolvedValue({
      enabled: false,
      unlocked: true,
      corrupt: true,
      webauthn: false,
      credentials: [],
    });
    render(<LockSettings readOnly={false} />);
    expect(
      await screen.findByText("Lock store was unreadable and has been set aside — register a device again."),
    ).toBeInTheDocument();
  });

  it("shows read-only protection", async () => {
    render(<LockSettings readOnly />);
    await waitFor(() => expect(screen.getByText("Add this device")).toBeDisabled());
    expect(screen.getByText(/isn't authorised/)).toBeInTheDocument();
  });

  it("turns off the reconnect lock with clearLock", async () => {
    vi.mocked(fetchLockStatus).mockResolvedValue({
      enabled: true,
      unlocked: true,
      webauthn: true,
      credentials: [{ id: "x", name: "Phone", addedAt: 0 }],
    });
    vi.mocked(clearLock).mockResolvedValue({ ok: true });
    render(<LockSettings readOnly={false} />);
    fireEvent.click(await screen.findByText("Turn off reconnect lock"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(clearLock).toHaveBeenCalled());
  });

  it("disables Add this device for read-only devices", async () => {
    render(<LockSettings readOnly />);
    await waitFor(() => expect(screen.getByText("Add this device")).toBeDisabled());
  });
});
