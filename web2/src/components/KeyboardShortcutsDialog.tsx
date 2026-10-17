/**
 * The shortcuts sheet (`?`, T13): every binding in the default table, with the key as this platform
 * spells it and the context it needs. The table is code in this slice, so the sheet is read-only.
 */
import { create } from "zustand";

import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { COMMAND_LABEL, formatShortcutLabel, KEYBINDINGS } from "@/keybindings";

import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Kbd } from "./ui/kbd";

export const useShortcutsDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openShortcutsDialog(): void {
  useShortcutsDialog.setState({ open: true });
}

const WHEN_LABEL: Record<string, string> = {
  "!terminalFocus": "not while typing into the terminal",
  composerFocus: "in the message box",
  "composerFocus && turnRunning": "in the message box, while the agent works",
  "!terminalFocus && !editableFocus": "outside text fields",
  "!editableFocus && !terminalFocus": "outside text fields",
};

export function KeyboardShortcutsDialog() {
  const open = useShortcutsDialog((s) => s.open);
  const newThreadKeys = KEYBINDINGS.filter((b) => b.command === "chat.new").map((b) => formatShortcutLabel(b.shortcut));
  return (
    <Dialog open={open} onOpenChange={(next) => useShortcutsDialog.setState({ open: next })}>
      <DialogPopup className="max-w-lg max-sm:pb-[env(safe-area-inset-bottom)]">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <table className="w-full text-sm" aria-label="Keyboard shortcuts">
            <tbody>
              {KEYBINDINGS.map((binding, index) => {
                const rule = DEFAULT_KEYBINDINGS[index];
                const when = rule?.when ? (WHEN_LABEL[rule.when] ?? rule.when) : null;
                return (
                  <tr key={`${binding.command}:${index}`} className="border-b last:border-b-0" data-shortcut={binding.command}>
                    <td className="py-1.5 pe-3 align-top">
                      <Kbd>{formatShortcutLabel(binding.shortcut)}</Kbd>
                    </td>
                    <td className="py-1.5 align-top">
                      <span className="text-foreground">{COMMAND_LABEL[binding.command]}</span>
                      {when ? <span className="block text-xs text-muted-foreground">{when}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Your browser may keep {newThreadKeys[0]} for itself; New thread is also on {newThreadKeys[1]} and in the command palette.
          </p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
