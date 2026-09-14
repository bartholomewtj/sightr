import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/router", () => ({ router: {} }));
vi.mock("react-router", () => ({ RouterProvider: () => <div data-testid="router-provider" /> }));
vi.mock("@/components/busy-bar", () => ({ BusyBar: () => null }));
vi.mock("@/components/lock-prompt", () => ({ LockPrompt: () => <div data-testid="lock-prompt" /> }));
vi.mock("@/hooks/use-lock-gate", () => ({ useLockGate: vi.fn(() => ({ gate: { status: "open" }, onUnlocked: vi.fn() })) }));
import { App } from "./App";
import { useLockGate } from "@/hooks/use-lock-gate";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useLockGate).mockReturnValue({ gate: { status: "open" }, onUnlocked: vi.fn() });
});

describe("App push onboarding placement", () => {
  it("leaves onboarding to the home column after the gate opens", () => {
    render(<App />);
    expect(screen.getByTestId("router-provider")).toBeInTheDocument();
    expect(screen.queryByTestId("push-onboarding")).not.toBeInTheDocument();
  });

  it("does not render the home column behind the lock gate", () => {
    vi.mocked(useLockGate).mockReturnValue({ gate: { status: "locked" } as never, onUnlocked: vi.fn() });
    render(<App />);
    expect(screen.queryByTestId("router-provider")).not.toBeInTheDocument();
  });
});

describe("App reconnect gate", () => {
  it.each([
    ["locked", "lock-prompt", "router-provider"],
    ["open", "router-provider", "lock-prompt"],
  ] as const)("renders the %s gate", (status, present, absent) => {
    vi.mocked(useLockGate).mockReturnValue({ gate: { status } as never, onUnlocked: vi.fn() });
    render(<App />);
    expect(screen.getByTestId(present)).toBeInTheDocument();
    expect(screen.queryByTestId(absent)).not.toBeInTheDocument();
  });
});

