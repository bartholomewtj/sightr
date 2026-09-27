import { fireEvent, screen } from "@testing-library/react";

// The pane header is one line; the cwd, Context, Find, the tab's pane list, the agent statusline and
// the Switch pane row live behind the title (the pane menu). Tests that used to reach those
// straight off the header open the sheet first. Synchronous fireEvent so the helpers work inside
// both fireEvent- and userEvent-driven tests without an await.

/** Open the pane details sheet (or popover) and return its dialog. */
export function openPaneDetails(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Pane menu" }));
  return screen.getByRole("dialog");
}

/** Open the pane details sheet and choose one of its rows by label. The sheet closes on the choice. */
export function pickPaneDetails(label: string | RegExp): void {
  openPaneDetails();
  fireEvent.click(screen.getByRole("button", { name: label }));
}
