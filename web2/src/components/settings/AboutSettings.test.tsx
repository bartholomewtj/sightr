import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { observeServerBuild } from "@/lib/server-build";
import { server } from "@/test/setup";

const checkForUpdate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/pwa", () => ({ checkForUpdate }));

import { AboutSettings, updateState } from "./AboutSettings";

beforeEach(() => {
  checkForUpdate.mockClear();
  server.use(http.get("/api/build", () => HttpResponse.json({}), { once: false }));
});

describe("updateState", () => {
  it("compares the running build with the one the bridge serves", () => {
    expect(updateState("a1", undefined)).toBe("unknown");
    expect(updateState("a1", "unknown")).toBe("unknown");
    expect(updateState("unknown", "b2")).toBe("unknown");
    expect(updateState("a1", "a1")).toBe("current");
    expect(updateState("a1", "b2")).toBe("newer");
  });
});

describe("Settings → About", () => {
  it("shows the build and asks the service worker for an update on tap", async () => {
    render(<AboutSettings />);
    expect(screen.getByText(new RegExp(`build ${__BUILD_INFO__.id}`))).toBeInTheDocument();
    expect(screen.getByText("Not checked yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("You are on the latest version.")).toBeInTheDocument();
  });

  it("offers Reload to update when the bridge serves another build", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<AboutSettings />);
    act(() => observeServerBuild("some-newer-build"));
    expect(await screen.findByText("A newer version is ready. Reload to use it.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload to update" }));
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("says the bridge's build is the one running when they match", async () => {
    render(<AboutSettings />);
    act(() => observeServerBuild(__BUILD_INFO__.id));
    expect(await screen.findByText("You are on the version the bridge serves.")).toBeInTheDocument();
  });

  it("shows the open-source notice behind a fold, with a link to T3 Code", () => {
    render(<AboutSettings />);
    expect(screen.queryByTestId("licence-notice")).toBeNull();
    expect(screen.getByRole("link", { name: /T3 Code/ })).toHaveAttribute("href", "https://github.com/pingdotgg/t3code");
    fireEvent.click(screen.getByRole("button", { name: "Show the notice" }));
    expect(screen.getByTestId("licence-notice")).toHaveTextContent("MIT License");
    expect(screen.getByTestId("licence-notice")).toHaveTextContent("T3 Tools Inc.");
  });
});
