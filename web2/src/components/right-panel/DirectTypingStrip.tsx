// Copied from web/src/components/direct-typing-strip.tsx (T13: the Terminal tab). Changes: `prompt`
// names the password prompt the operator is answering (T12's "Open terminal" hand-off); `compact`
// (a phone with its keyboard up) shows the strip only when it has something to say: a held paste or
// a password prompt. Its plain "Typing into terminal … Stop" line repeats the armed Stop button.
import { Keyboard } from "lucide-react";
import type { PointerEvent } from "react";
import { usePasteHold } from "@/lib/paste-hold";

// The armed indicator for direct typing, in the same in-flow slot as the "You sent:" strip.
//
// WHY THIS EXISTS ON TOP OF THE RESTYLED BUTTON AND TEXTAREA. Those two are exactly the elements a
// user stops looking at once they start typing, so they fail the glance-back test: come back to the
// phone twenty seconds later and nothing in your field of view says the next keystroke goes straight
// into a running agent. This strip sits where the eye already goes for composer state, cannot scroll
// away, and says what is happening in words.
//
// WHEN THIS REACHES THE PACK BRANCH IT MUST NAME THE HOST. On v1 every write surface carries a
// HostChip, because a write names its target; a mode that streams keystrokes into a terminal without
// saying WHICH machine would be the one write path that doesn't. That component does not exist on
// main, so the chip goes in at the merge, next to the label below.
export function DirectTypingStrip({
  onStop,
  disabled = false,
  reason,
  prompt,
  compact = false,
}: { onStop: () => void; disabled?: boolean; reason?: string; prompt?: string; compact?: boolean }) {
  const hold = usePasteHold();
  if (compact && !disabled && hold === null && !prompt) return null;
  const buttonProps = { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => event.preventDefault() };
  return (
    <div data-direct-strip="" className={`flex items-center gap-2 px-1 pb-1 text-xs ${disabled ? "text-muted-foreground" : "text-primary"}`}>
      <Keyboard className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{hold && !disabled ? hold.kind === "text" ? `Paste ${hold.lines} line${hold.lines === 1 ? "" : "s"} into the terminal?` : "Image added" : "Typing into terminal"}</span>
        <span className="text-muted-foreground"> — {disabled ? reason : hold?.kind === "text" ? hold.reason ?? "" : hold?.kind === "path" ? hold.path : prompt ? `answering: ${prompt}` : "keys go straight through"}</span>
      </span>
      {!disabled && hold?.kind === "text" && (
        <>
          <button type="button" {...buttonProps} onClick={hold.onSend} className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted">Send</button>
          <button type="button" {...buttonProps} onClick={hold.onDiscard} className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted">Discard</button>
        </>
      )}
      {!disabled && hold?.kind === "path" && (
        <>
          <button type="button" {...buttonProps} onClick={hold.onSend} className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted">Type path</button>
          <button type="button" {...buttonProps} onClick={hold.onDiscard} className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted">Discard</button>
        </>
      )}
      {!disabled && hold === null && (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted"
        >
          Stop
        </button>
      )}
    </div>
  );
}
