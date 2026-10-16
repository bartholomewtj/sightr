// Adapted from T3 Code apps/web/src/commandPaletteBus.ts @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: a Zustand store in place of the window event, so `paletteOpen` is readable for the
// keybinding context; no linked-thread or add-project intents.
import { create } from "zustand";

export interface CommandPaletteOpenDetail {
  readonly query?: string;
}

interface CommandPaletteState {
  open: boolean;
  /** The query the palette opens with (T3's `OpenSearch` intent). */
  initialQuery: string;
}

export const useCommandPaletteStore = create<CommandPaletteState>(() => ({ open: false, initialQuery: "" }));

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  useCommandPaletteStore.setState({ open: true, initialQuery: detail?.query ?? "" });
}

export function closeCommandPalette(): void {
  if (useCommandPaletteStore.getState().open) useCommandPaletteStore.setState({ open: false, initialQuery: "" });
}

export function toggleCommandPalette(): void {
  if (useCommandPaletteStore.getState().open) closeCommandPalette();
  else openCommandPalette();
}

export function isCommandPaletteOpen(): boolean {
  return useCommandPaletteStore.getState().open;
}

/** Test helper. */
export function __resetCommandPalette(): void {
  useCommandPaletteStore.setState({ open: false, initialQuery: "" });
}
