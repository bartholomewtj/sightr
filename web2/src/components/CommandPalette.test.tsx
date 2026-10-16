import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { setDirectArmed } from "@v1/lib/direct-arm";
import { useCommandPaletteStore } from "@/commandPaletteBus";
import { useRightPanelStore } from "@/rightPanelStore";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { useUiState } from "@/uiStateStore";

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

async function boot(path = "/v2/", width = 1280) {
  setViewportWidth(width);
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() =>
    shellSource()?.emit(
      "snapshot",
      shellSnapshot(5, [
        thread("t1", { title: "Fix the build", lastActivityAt: 10 }),
        thread("t2", { title: "Write the docs", lastActivityAt: 20, status: "approval" }),
      ]),
    ),
  );
  return app;
}

const palette = () => screen.findByTestId("command-palette");
const modK = () => fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });

describe("command palette", () => {
  it("mod+k opens it with Needs you first; typing and Enter jumps to the thread", async () => {
    const { router } = await boot();
    modK();
    const dialog = await palette();
    const labels = within(dialog).getAllByText(/^(Needs you|Recent threads|Actions)$/).map((n) => n.textContent);
    expect(labels).toEqual(["Needs you", "Recent threads", "Actions"]);
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "fix" } });
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Fix the build"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(router.history.location.pathname).toBe("/v2/thread/t1"));
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("runs an action through the same function as its button", async () => {
    await boot("/v2/thread/t1");
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">open git" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Open Git/ }));
    await waitFor(() => expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "git" }));
  });

  it("mod+k is off while direct typing is armed; mod+b still toggles the sidebar", async () => {
    await boot();
    act(() => setDirectArmed(true));
    modK();
    await new Promise((r) => setTimeout(r, 20));
    expect(useCommandPaletteStore.getState().open).toBe(false);
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(useUiState.getState().sidebarOpen).toBe(false);
    act(() => setDirectArmed(false));
  });

  it("opens from the sidebar's button on a phone, full height", async () => {
    await boot("/v2/", 390);
    fireEvent.click(await screen.findByRole("button", { name: "Command palette" }));
    expect(await palette()).toHaveClass("max-h-none");
  });
});

describe("shortcuts sheet", () => {
  it("? outside a text field lists every default binding", async () => {
    await boot();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true, code: "Slash" });
    const table = await screen.findByRole("table", { name: "Keyboard shortcuts" });
    expect(within(table).getAllByRole("row")).toHaveLength(DEFAULT_KEYBINDINGS.length);
    for (const rule of DEFAULT_KEYBINDINGS) expect(table.querySelector(`[data-shortcut="${rule.command}"]`)).not.toBeNull();
  });

  it("? in a text field types a question mark", async () => {
    await boot();
    const search = await screen.findByRole("searchbox", { name: "Search threads" });
    search.focus();
    fireEvent.keyDown(search, { key: "?", shiftKey: true, code: "Slash" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("table", { name: "Keyboard shortcuts" })).toBeNull();
  });
});
