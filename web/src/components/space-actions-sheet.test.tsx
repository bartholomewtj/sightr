import { setDesktop, __resetDesktop } from "@/lib/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import type { WorkspaceView } from "@/lib/types";
import { SpaceActionsSheet } from "./space-actions-sheet";

// The space actions sheet (opened from the ⋯ button or right-click) — same structure as the tab
// sheet: Rename, Close space, and Delete checkout on a linked worktree. Rename is a second tap
// so opening the sheet never shoves a keyboard-triggering input at you. Like a tab, a blank space
// label can't be saved (herdr has no "clear" for a workspace). Wired to the bridge via lib/api
// (exercised through MSW); the parent gets onRenamed / onClosed.

beforeEach(() => clearStatus());

const workspace: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "sightr",
  focused: true,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 2,
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof SpaceActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof SpaceActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    workspace,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
  render(<SpaceActionsSheet {...props} />);
  return props;
}

describe("SpaceActionsSheet — action list", () => {
  it("opens on the action list, not the rename input, with close and without delete checkout", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close space" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete checkout/i })).toBeNull();
    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
  });

  it("offers delete checkout on a linked worktree child", () => {
    renderSheet({
      workspace: {
        ...workspace,
        worktree: {
          repoKey: "r",
          repoName: "sightr",
          repoRoot: "/sightr",
          checkoutPath: "/sightr-foo",
          isLinkedWorktree: true,
          branch: "foo",
        },
      },
    });
    expect(screen.getByRole("button", { name: "Delete checkout" })).toBeInTheDocument();
  });

  it("names a group close when the space has linked children", () => {
    renderSheet({ linkedChildCount: 2 });
    expect(screen.getByRole("button", { name: "Close group" })).toBeInTheDocument();
  });
});

describe("SpaceActionsSheet — rename", () => {
  it("stays on the action list until Rename is tapped, then shows the prefilled input", async () => {
    const user = userEvent.setup();
    renderSheet({ workspace: { ...workspace, label: "deploy" } });
    expect(screen.queryByPlaceholderText("name this space")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this space")).toHaveValue("deploy");
  });

  it("autofocuses the input once rename mode opens", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByPlaceholderText("name this space")).toHaveFocus());
  });

  it("Back returns to the action list without saving", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("posts the trimmed label, then calls onRenamed and closes", async () => {
    const user = userEvent.setup();
    let body: unknown;
    let url = "";
    server.use(
      http.post(/\/api\/workspace\/[^/]+\/rename$/, async ({ request }) => {
        url = request.url;
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this space");
    await user.clear(input);
    await user.type(input, "  api  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledTimes(1));
    expect(body).toEqual({ label: "api" });
    expect(url).toContain("/api/workspace/w1/rename");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("disables Save on a blank field — a space has no clear", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    await user.clear(screen.getByPlaceholderText("name this space"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does NOT revalidate or close when the rename fails (error goes to the status channel)", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(/\/api\/workspace\/[^/]+\/rename$/, () =>
        HttpResponse.json({ ok: false, error: "workspace not found" }),
      ),
    );
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByPlaceholderText("name this space");
    await user.clear(input);
    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled());
    expect(props.onRenamed).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("resets back to the action list when the sheet reopens, even mid-rename", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SpaceActionsSheet open={true} onClose={vi.fn()} workspace={workspace} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this space")).toBeInTheDocument();

    rerender(
      <SpaceActionsSheet open={false} onClose={vi.fn()} workspace={workspace} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    rerender(
      <SpaceActionsSheet open={true} onClose={vi.fn()} workspace={workspace} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );

    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("resets back to the action list when the target workspace changes, even mid-rename", async () => {
    const user = userEvent.setup();
    const other: WorkspaceView = { ...workspace, workspaceId: "w2", label: "other" };
    const { rerender } = render(
      <SpaceActionsSheet open={true} onClose={vi.fn()} workspace={workspace} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this space")).toBeInTheDocument();

    rerender(
      <SpaceActionsSheet open={true} onClose={vi.fn()} workspace={other} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );

    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  // The label is user text; it must render only as an <input> value / text node, never markup — same
  // XSS boundary as pane labels and pane output.
  it("renders a markup-looking label as literal text, injecting nothing", async () => {
    const user = userEvent.setup();
    const xss = "<img src=x onerror=alert(1)>";
    renderSheet({ workspace: { ...workspace, label: xss } });
    expect(document.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByPlaceholderText("name this space")).toHaveValue(xss);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("SpaceActionsSheet — close", () => {
  it("closes only after a two-tap confirm, then calls onClosed", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/workspace\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })));
    const props = renderSheet();
    await user.click(screen.getByRole("button", { name: "Close space" }));
    expect(props.onClosed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /tap again to close/i }));
    await waitFor(() => expect(props.onClosed).toHaveBeenCalledExactlyOnceWith("w1"));
  });

  it("sends closeGroup when the space has linked children", async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      http.post(/\/api\/workspace\/[^/]+\/close$/, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    renderSheet({ linkedChildCount: 2 });
    await user.click(screen.getByRole("button", { name: "Close group" }));
    await user.click(screen.getByRole("button", { name: /tap again to close 3 spaces/i }));
    await waitFor(() => expect(body).toEqual({ closeGroup: true }));
  });
});

describe("SpaceActionsSheet — read-only", () => {
  it("shows a note and no write actions when the device isn't authorised", () => {
    renderSheet({ readOnly: true });
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByPlaceholderText("name this space")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

// Folded from space-actions-sheet-desktop.test.tsx.
describe('SpaceActionsSheet desktop', () => {
  const workspace: WorkspaceView = { workspaceId: "w", number: 1, label: "one", focused: true, activeTabId: "t", tabCount: 1, paneCount: 1 };
  const props = { open: true, onClose: vi.fn(), workspace, onRenamed: vi.fn(), onClosed: vi.fn() };
  afterEach(() => { cleanup(); __resetDesktop(); });
  describe("SpaceActionsSheet desktop", () => {
    it("renders rename in the anchored popover", () => { setDesktop(true); render(<SpaceActionsSheet {...props} anchor={{ x: 120, y: 200 }} />); const popover = screen.getByTestId("action-popover"); expect(popover).toHaveTextContent("Rename"); expect(popover).toHaveStyle({ left: "120px", top: "200px" }); expect(document.querySelector('button[aria-hidden="true"]')).toBeNull(); });
    it("uses the bottom sheet when desktop is off", () => { render(<SpaceActionsSheet {...props} />); expect(screen.queryByTestId("action-popover")).toBeNull(); expect(document.querySelector('button[aria-hidden="true"]')).not.toBeNull(); });
    it("keeps rename and Escape behaviour in the popover", () => { setDesktop(true); render(<SpaceActionsSheet {...props} workspace={{ ...workspace, label: "deploy" }} anchor={{ x: 1, y: 2 }} />); fireEvent.click(screen.getByRole("button", { name: "Rename" })); expect(screen.getByPlaceholderText("name this space")).toHaveValue("deploy"); fireEvent.keyDown(window, { key: "Escape" }); expect(props.onClose).toHaveBeenCalled(); });
  });
});