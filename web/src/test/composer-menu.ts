import { fireEvent, screen } from "@testing-library/react";

// The composer's controls live behind the + ("More") at the left edge of the reply field. Tests
// that used to click Keys / Display settings / Attach file straight off the control row open the
// menu first. Synchronous fireEvent so the helpers work inside both fireEvent- and userEvent-driven
// tests without an await.

/** Open the + menu and return its dialog. */
export function openMore(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("dialog", { name: "More" });
}

/** Open the + menu and choose one of its rows by label. The menu closes on the choice. */
export function pickMore(label: string | RegExp): void {
  openMore();
  fireEvent.click(screen.getByRole("button", { name: label }));
}

/** Open the + menu and flip the Terminal toggle (a checkbox row, not a button). */
export function toggleTerminal(): void {
  openMore();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Terminal" }));
}
