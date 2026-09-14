import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/lib/push", async (original) => ({
  ...(await original()),
  enablePush: vi.fn(),
  reattachPush: vi.fn(),
}));

import { usePushDevice, usePushSetup } from "./use-push";
import {
  enablePush,
  reattachPush,
  isPushDisabledByUser,
  resetPushDevice,
} from "@/lib/push";

function setNotification(permission: NotificationPermission) {
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission, requestPermission: vi.fn() },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {},
  });
}

describe("usePushSetup", () => {
  beforeEach(() => {
    resetPushDevice();
    vi.mocked(enablePush).mockReset();
    vi.mocked(reattachPush).mockReset();
    vi.mocked(reattachPush).mockResolvedValue({ skipped: false, result: { ok: true } });
    setNotification("default");
  });

  it("does not request permission on mount when permission is default", () => {
    const requestPermission = window.Notification.requestPermission as ReturnType<typeof vi.fn>;
    renderHook(() => usePushSetup());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(enablePush).not.toHaveBeenCalled();
  });

  it("auto-subscribes when permission is already granted", () => {
    setNotification("granted");
    renderHook(() => usePushSetup());
    expect(reattachPush).toHaveBeenCalledTimes(1);
  });

  it("does not auto-subscribe when the user disabled push", () => {
    localStorage.setItem("sightr:push-disabled", "1");
    expect(isPushDisabledByUser()).toBe(true);
    setNotification("granted");
    renderHook(() => usePushSetup());
    expect(enablePush).not.toHaveBeenCalled();
  });

  it("publishes the snapshot device state", () => {
    const { result } = renderHook(() => {
      usePushSetup({ enforced: true, device: "phone", authorized: false });
      return usePushDevice();
    });
    expect(result.current).toEqual({ seen: true, readOnly: true });
  });
});
