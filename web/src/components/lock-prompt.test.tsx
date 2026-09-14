import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LockPrompt } from "./lock-prompt";
import { fetchLockStatus, unlockWebauthn, webauthnChallenge } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchLockStatus: vi.fn(),
  webauthnChallenge: vi.fn(),
  unlockWebauthn: vi.fn(),
  b64uToBytes: vi.fn(() => new Uint8Array(4)),
  bytesToB64u: vi.fn(() => "AAAA"),
}));

const get = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchLockStatus).mockResolvedValue({ enabled: true, unlocked: false, webauthn: true, allowCredentials: ["id"] });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window, "PublicKeyCredential", { value: function () {}, configurable: true });
  Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
  get.mockReset();
});

describe("LockPrompt", () => {
  it("offers device unlock only after a tap", async () => {
    vi.mocked(webauthnChallenge).mockResolvedValue({
      challenge: "c",
      rpId: "x",
      rpName: "Sightr",
      userId: "u",
      allowCredentials: ["id"],
      timeout: 60000,
    });
    vi.mocked(unlockWebauthn).mockResolvedValue({ ok: true });
    get.mockResolvedValue({
      id: "id",
      response: { clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1) },
    });
    const done = vi.fn();
    render(<LockPrompt onUnlocked={done} />);
    await waitFor(() => screen.getByRole("button", { name: "Unlock with this device" }));
    expect(get).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlock with this device" }));
    await waitFor(() => expect(unlockWebauthn).toHaveBeenCalled());
    expect(done).toHaveBeenCalled();
  });

  it("shows cancellation without a text field", async () => {
    vi.mocked(webauthnChallenge).mockRejectedValue(new Error("cancel"));
    render(<LockPrompt onUnlocked={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Unlock with this device" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlock with this device" }));
    expect(await screen.findByText("Couldn't unlock with this device")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("explains when this browser cannot unlock", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render(<LockPrompt onUnlocked={vi.fn()} />);
    expect(await screen.findByText(/can't use device unlock/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlock with this device" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
