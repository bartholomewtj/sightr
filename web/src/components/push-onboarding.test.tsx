import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/push", async (original) => ({
  ...(await original()),
  getPushState: vi.fn(),
  enablePush: vi.fn(),
}));

import { PushOnboarding } from "./push-onboarding";
import {
  enablePush,
  getPushState,
  isPushDisabledByUser,
  isPushOnboarded,
  PUSH_DISMISS_MS,
  notePushDevice,
  resetPushDevice,
  type PushState,
  IOS_INSTALL_NOTE, IOS_INSTALL_STEPS, IOS_INSTALL_TITLE,
} from "@/lib/push";

const ready = { availability: "ready" as const, subscribed: false, userDisabled: false };

function setNotification(permission: NotificationPermission) {
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission, requestPermission: vi.fn() },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
}

function renderReady(
  permission: NotificationPermission = "default",
  state: PushState = ready,
) {
  setNotification(permission);
  notePushDevice(undefined);
  vi.mocked(getPushState).mockResolvedValue(state);
  return render(<PushOnboarding />);
}

describe("PushOnboarding", () => {
  beforeEach(() => {
    resetPushDevice();
    vi.mocked(getPushState).mockReset();
    vi.mocked(enablePush).mockReset();
    setNotification("default");
  });

  it("renders the first-run card when push is ready", async () => {
    renderReady();
    expect(await screen.findByRole("heading", { name: "Get a notification when an agent needs you." })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Turn on notifications" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("turns on from the tap and remembers success", async () => {
    vi.mocked(enablePush).mockResolvedValue({ ok: true });
    renderReady();
    await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    expect(enablePush).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("push-onboarding")).not.toBeInTheDocument());
    expect(localStorage.getItem("sightr:push-onboarding:v1")).toBe("1");
  });

  it("shows a failure while leaving Not now available", async () => {
    vi.mocked(enablePush).mockResolvedValue({ ok: false, reason: "denied" });
    renderReady();
    await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    expect(await screen.findByText("Notifications are blocked — enable them in your browser settings.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(localStorage.getItem("sightr:push-onboarding:dismissed-at")).not.toBeNull();
  });

  it("Not now only records onboarding, not push disabled", async () => {
    renderReady();
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("push-onboarding")).not.toBeInTheDocument();
    expect(localStorage.getItem("sightr:push-onboarding:dismissed-at")).not.toBeNull();
    expect(isPushOnboarded()).toBe(false);
    expect(isPushDisabledByUser()).toBe(false);
  });

  it("suppresses a fresh dismissal for seven days and shows it after expiry", async () => {
    const first = renderReady();
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    first.unmount();
    renderReady();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("push-onboarding")).toBeNull();
    localStorage.setItem("sightr:push-onboarding:dismissed-at", String(Date.now() - PUSH_DISMISS_MS - 1));
    renderReady();
    expect(await screen.findByTestId("push-onboarding")).toBeInTheDocument();
  });

  it.each([
    ["permission denied", () => renderReady("denied")],
    ["server off", () => { renderReady("default", { ...ready, availability: "server-off" }); }],
    ["insecure", () => { renderReady("default", { ...ready, availability: "insecure" }); }],
    ["read-only", () => { setNotification("default"); notePushDevice({ enforced: true, device: "d", authorized: false }); vi.mocked(getPushState).mockResolvedValue(ready); render(<PushOnboarding />); }],
    ["onboarded", () => { localStorage.setItem("sightr:push-onboarding:v1", "1"); renderReady(); }],
    ["user disabled", () => { localStorage.setItem("sightr:push-disabled", "1"); setNotification("default"); notePushDevice(undefined); vi.mocked(getPushState).mockResolvedValue({ ...ready, userDisabled: true }); render(<PushOnboarding />); }],
  ])("renders nothing for %s", async (_name, setup) => {
    setup();
    await waitFor(() => expect(screen.queryByTestId("push-onboarding")).not.toBeInTheDocument());
  });

  it("shows iOS Home Screen instructions and all steps", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "iPhone Safari" });
    vi.mocked(getPushState).mockResolvedValue({ ...ready, availability: "unsupported" });
    notePushDevice(undefined);
    render(<PushOnboarding />);
    expect(await screen.findByRole("heading", { name: IOS_INSTALL_TITLE })).toBeInTheDocument();
    expect(screen.getByText(IOS_INSTALL_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "How" }));
    for (const step of IOS_INSTALL_STEPS) expect(screen.getByText(step)).toBeInTheDocument();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Chrome desktop" });
  });

  it("does not probe before a snapshot has landed", async () => {
    setNotification("default");
    render(<PushOnboarding />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getPushState).not.toHaveBeenCalled();
  });
});
