import { fireEvent, render, screen } from "@testing-library/react";

import { BottomSheet, SideSheet } from "./sheet";

// Focus + labelling: the sheets are role=dialog/aria-modal, so they should be named by their title,
// move focus inside on open, restore it on close, and expose exactly ONE accessible "Close" (the
// header ✕) — the full-screen backdrop stays tappable but is hidden from assistive tech.
describe("sheet — inert background", () => {
  it.each(["bottom", "side"])("marks page siblings inert while %s sheet is open", (kind) => {
    const root = document.createElement("div"); root.id = "root"; document.body.append(root);
    const page = document.createElement("main"); page.textContent = "page"; root.append(page);
    const host = document.createElement("div"); root.append(host);
    const Sheet = kind === "bottom" ? BottomSheet : SideSheet;
    const { rerender } = render(<Sheet open onClose={vi.fn()} title="Modal">body</Sheet>, { container: host });
    expect(page).toHaveAttribute("inert");
    expect(host.querySelector('button[aria-hidden="true"]')).not.toHaveAttribute("inert");
    rerender(<Sheet open={false} onClose={vi.fn()} title="Modal">body</Sheet>);
    expect(page).not.toHaveAttribute("inert");
    root.remove();
  });
});

describe("sheet — focus & labelling", () => {
  it("labels the dialog with its title (aria-labelledby)", () => {
    render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Keys" })).toBeInTheDocument();
  });

  it("exposes a single accessible Close (✕); the backdrop is aria-hidden but still dismisses on a real tap (down+up on it)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <SideSheet open onClose={onClose} title="Navigate">
        body
      </SideSheet>,
    );
    // Only the header ✕ is in the a11y tree now — no giant duplicate "Close" from the backdrop.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    // ...but the backdrop still closes on a genuine press-and-release on it.
    const backdrop = container.querySelector('button[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    // Focus is now inside the dialog panel (not left on the opener behind the modal).
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <BottomSheet open={false} onClose={vi.fn()} title="Keys">
        body
      </BottomSheet>,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

// The on-device bug: a touch that opens the sheet can leave the finger down at mount time: the
// browser's release `click` lands wherever the finger now is, which is the backdrop — and closing on
// ANY backdrop click meant the sheet closed in the same instant it opened. The fix arms the dismiss
// only when the pointer went DOWN on the backdrop too (press AND release on it), so a click whose
// pointerdown started elsewhere (the pill, in the real gesture) is ignored.
describe("BottomSheet — backdrop dismiss requires press AND release on the backdrop", () => {
  it("stays open when pointerdown happened elsewhere (not the backdrop) and only the click lands on it", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    // Simulate the pointerdown landing on something other than the backdrop (e.g. the pane pill that
    // opened the sheet), then the release click landing on the backdrop.
    fireEvent.pointerDown(document.body);
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes when both pointerdown and click land on the backdrop (a genuine backdrop tap)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the ✕ button still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-arms per open: a stale arm from a previous open doesn't leak into the next one", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    const backdrop = () => container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop());
    // Close via Escape instead of the (now-armed) backdrop click, leaving the arm flag set to true.
    fireEvent.keyDown(window, { key: "Escape" });
    rerender(
      <BottomSheet open={false} onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    rerender(
      <BottomSheet open onClose={onClose} title="Actions">
        body
      </BottomSheet>,
    );
    onClose.mockClear();
    // A click with no pointerdown in this new open should NOT close, even though a stale arm from the
    // previous open was left set to true.
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("BottomSheet — entrance and panelStyle", () => {
  it("defaults to slide-in-from-bottom; enter='fade' uses fade-in and panelStyle sets inline styles", () => {
    const { container, rerender } = render(
      <BottomSheet open onClose={vi.fn()} title="Actions">
        body
      </BottomSheet>,
    );
    const panel = container.querySelector("div[tabindex='-1']") as HTMLElement;
    expect(panel).toHaveClass("slide-in-from-bottom");
    expect(panel).not.toHaveClass("fade-in");

    rerender(
      <BottomSheet open onClose={vi.fn()} title="Actions" enter="fade" panelStyle={{ maxHeight: "100px" }}>
        body
      </BottomSheet>,
    );
    expect(panel).not.toHaveClass("slide-in-from-bottom");
    expect(panel).toHaveClass("fade-in");
    expect(panel.style.maxHeight).toBe("100px");
  });
});
