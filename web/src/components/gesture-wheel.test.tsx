import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { GestureWheel, WHEEL_ECHO_MS } from "./gesture-wheel";
import { layoutSlices, SHIPPED_WHEEL, type WheelSlice } from "@/lib/wheel";

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

describe("GestureWheel", () => {
  let onKeys = vi.fn<(keys: string[]) => Promise<boolean>>();
  let onType = vi.fn<() => void>();
  let onTap = vi.fn<() => void>();

  beforeEach(() => {
    vi.useFakeTimers();
    onKeys = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    onType = vi.fn<() => void>();
    onTap = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderWheel(props?: {
    slices?: readonly WheelSlice[];
    typeActive?: boolean;
    disabled?: boolean;
  }) {
    return render(
      <GestureWheel
        slices={props?.slices ?? SHIPPED_WHEEL}
        onKeys={onKeys}
        onType={onType}
        typeActive={props?.typeActive ?? false}
        onTap={onTap}
        disabled={props?.disabled ?? false}
      />,
    );
  }

  it("1. a press released after 100ms calls onTap once and opens nothing", () => {
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerUp(handle, { clientX: 358, clientY: 700, pointerId: 1 });

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("2. a press held past 180ms opens the fan: all four slices are on screen and onTap was not called", () => {
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(onTap).not.toHaveBeenCalled();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(4);
  });

  it("3. drag to the Enter bearing and release -> onKeys called exactly once with ['Enter']; further pointer events send nothing; the fan closes after the echo window", async () => {
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Enter slice is at index 2 (120 deg)
    const pt = layoutSlices(4)[2]!;
    const enterX = 358 + pt.dx;
    const enterY = 700 + pt.dy;

    fireEvent.pointerMove(handle, { clientX: enterX, clientY: enterY, pointerId: 1 });
    await act(async () => {
      fireEvent.pointerUp(handle, { clientX: enterX, clientY: enterY, pointerId: 1 });
    });

    expect(onKeys).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledWith(["Enter"]);

    // Further pointer events send nothing
    fireEvent.pointerMove(handle, { clientX: enterX, clientY: enterY, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: enterX, clientY: enterY, pointerId: 1 });
    expect(onKeys).toHaveBeenCalledTimes(1);

    // Fan closes after echo window
    act(() => {
      vi.advanceTimersByTime(WHEEL_ECHO_MS);
    });
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("4. release inside the dead zone leaves the fan open; a following click on Esc sends ['Escape']", async () => {
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Release inside dead zone (dx=0, dy=0)
    fireEvent.pointerUp(handle, { clientX: 358, clientY: 700, pointerId: 1 });
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);

    const esc = screen.getByRole("menuitem", { name: "Esc" });
    await act(async () => {
      fireEvent.click(esc);
    });

    expect(onKeys).toHaveBeenCalledTimes(1);
    expect(onKeys).toHaveBeenCalledWith(["Escape"]);
  });

  it("5. release far outside the ring closes the fan and sends nothing", () => {
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    fireEvent.pointerUp(handle, { clientX: 358 + 400, clientY: 700, pointerId: 1 });
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("6. a click on the Type slice calls onType and closes; with typeActive the same slice reads Stop", () => {
    const { unmount } = renderWheel({ typeActive: false });
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    fireEvent.pointerUp(handle, { clientX: 358, clientY: 700, pointerId: 1 }); // dead zone -> stays open
    const typeSlice = screen.getByRole("menuitem", { name: "Type" });
    fireEvent.click(typeSlice);

    expect(onType).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

    unmount();

    // Now render with typeActive = true
    renderWheel({ typeActive: true });
    const handle2 = screen.getByRole("button", { name: "Shortcut wheel" });
    fireEvent.pointerDown(handle2, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(screen.getByRole("menuitem", { name: "Stop" })).toBeDefined();
  });

  it("7. disabled -> pointer down does nothing, even held past the hold window", () => {
    renderWheel({ disabled: true });
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("8. six operator slices all render; the shipped four render when the list is the shipped one", () => {
    const sixSlices: WheelSlice[] = [
      { kind: "keys", label: "A", keys: ["a"] },
      { kind: "keys", label: "B", keys: ["b"] },
      { kind: "keys", label: "C", keys: ["c"] },
      { kind: "keys", label: "D", keys: ["d"] },
      { kind: "keys", label: "E", keys: ["e"] },
      { kind: "keys", label: "F", keys: ["f"] },
    ];

    const { unmount } = renderWheel({ slices: sixSlices });
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });
    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(6);

    unmount();

    renderWheel({ slices: SHIPPED_WHEEL });
    const handle2 = screen.getByRole("button", { name: "Shortcut wheel" });
    fireEvent.pointerDown(handle2, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });

  it("9. onKeys resolving false closes the wheel without wedging it (a second open still works)", async () => {
    onKeys.mockResolvedValue(false);
    renderWheel();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });

    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 1, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const pt = layoutSlices(4)[2]!;
    await act(async () => {
      fireEvent.pointerUp(handle, { clientX: 358 + pt.dx, clientY: 700 + pt.dy, pointerId: 1 });
    });

    expect(onKeys).toHaveBeenCalledTimes(1);

    // After echo window, wheel closes
    act(() => {
      vi.advanceTimersByTime(WHEEL_ECHO_MS);
    });
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

    // Second open still works
    fireEvent.pointerDown(handle, { clientX: 358, clientY: 700, pointerId: 2, button: 0 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
  });
});
