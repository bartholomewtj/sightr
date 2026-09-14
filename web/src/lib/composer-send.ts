import * as api from "@/lib/api";
import { sendGuardedReply } from "@/lib/actions";
const TUI_SETTLE_MS = 350;
interface SendResult {
  ok: boolean;
  status: { text: string; tone: "success" | "error" | "info" | "warn" } | null;
  clearDraft: boolean;
  armForce: boolean;
  resetForce: boolean;
  noEcho: { prompt: string; typed: boolean } | null;
  sent: string | null;
}
interface SendDeps {
  paneId: string;
  agent: string | undefined | null;
  dialogPresent: boolean;
  force: boolean;
  confirmDialog: () => boolean;
  isLocked: () => boolean;
  terminalLine: string | null;
  onStart: () => void;
  onKeysSent: () => void;
  isDraft: boolean;
  sendReply?: typeof sendGuardedReply;
  sendKeys?: typeof api.sendKeys;
  sleep?: (ms: number) => Promise<void>;
}
const emptyResult = (): SendResult => ({
  ok: false,
  status: null,
  clearDraft: false,
  armForce: false,
  resetForce: false,
  noEcho: null,
  sent: null,
});
const result = (
  ok: boolean,
  status: SendResult["status"],
  clearDraft = false,
  sent: string | null = null,
  armForce = false,
  noEcho: null | { prompt: string; typed: boolean } = null,
): SendResult => ({
  ok,
  status,
  clearDraft,
  armForce,
  resetForce: ok,
  noEcho,
  sent,
});
type SendTap =
  | { kind: "send"; force: boolean }
  | { kind: "arm-destructive"; status: { text: string; tone: "info" } };
export function planSendTap(
  _input: string,
  a: {
    forceArmed: boolean;
    destructiveConfirmed: boolean;
    destructiveReason: string | null;
  },
): SendTap {
  if (a.forceArmed) return { kind: "send", force: true };
  if (a.destructiveReason && !a.destructiveConfirmed)
    return {
      kind: "arm-destructive",
      status: {
        text: `Destructive: ${a.destructiveReason} — tap Send again to confirm`,
        tone: "info",
      },
    };
  return { kind: "send", force: false };
}
export async function runComposerSend(
  value: string,
  deps: SendDeps,
): Promise<SendResult> {
  const {
    paneId,
    agent,
    dialogPresent,
    force,
    confirmDialog,
    isLocked,
    terminalLine,
    onStart,
    onKeysSent,
  } = deps;
  const sendReply = deps.sendReply ?? sendGuardedReply;
  const sendKeys = deps.sendKeys ?? api.sendKeys;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const t = value.trim();
  let forced = force;
  if (!t) return emptyResult();
  // A dialog on screen owns the TUI's keyboard: our text is swallowed and the submit key ANSWERS
  // the dialog, approving whatever option was highlighted (collie#34). Refuse BEFORE the destructive
  // pre-clear sweep below — those ctrl+k/Backspaces would land in the dialog too. The input is
  // kept: the user answers the dialog with its own buttons, then taps Send again. We never
  // queue-and-auto-send, because the text may be a reaction to state the dialog just changed —
  // sending is consent, and the conditions moved.
  if (dialogPresent && !forced) {
    if (!confirmDialog()) {
      return result(false, {
        text: "A dialog is waiting — tap Send again to type past it.",
        tone: "error",
      });
    }
    forced = true;
  }
  onStart();
  try {
    // Guarded: types the text, verifies it reached the input box, and only THEN sends the submit
    // key. A "stalled" outcome means nothing was submitted and the draft must survive (collie#34).
    const res = await sendReply({
      paneId,
      text: t,
      agent,
      force: forced,
      // Clear a stranded draft on the terminal's "❯" line before pane.send_text appends at cursor —
      // ctrl+k kills cursor→end, Backspace sweep kills the head (actions.ts pattern). Skip
      // when there's no draft: a blind sweep races the TUI and Enter can fire before the PTY
      // settles. Keys on terminalLine (the actual current line, echo-suppressed), so our own
      // in-flight echo never triggers a (destructive) clear of a message that's already on its way,
      // and a live host draft is swept exactly once whether or not the user took it over first.
      //
      // Handed to the guard rather than run out here, because these are the most destructive keys
      // the composer sends and everything deciding to send them is a SNAPSHOT. `terminalLine` and
      // `dialogPresent` are both derived from the mirror's `display`, which lags the live pane by a
      // poll while following and is frozen outright while the user has scrolled back or opened
      // find. A dialog that went up in that gap leaves `dialogPresent` false and a draft still
      // visible, and the sweep lands in the dialog — the collie#34 failure one step upstream of where
      // collie#34 was fixed. The guard runs this ONLY after a live read has positively seen the composer,
      // which is why it is named for that and not for its position: `force` included, since a
      // forced retry is armed by a `blocked` outcome, i.e. by the app having just PROVEN a dialog
      // owns the keyboard. A forced send therefore types without sweeping and stalls if the line
      // really did hold a draft — which is what it did anyway, since the same detector that could
      // not see the box cannot read our text back out of it either.
      onComposerSeen: async ({ promptRegion }) => {
        // A deliberate dialog override must not run the destructive draft sweep: the mirror may be
        // stale, but the dialog detector is precisely why this second tap exists.
        if (forced || terminalLine === null)
          return { ok: true as const, keysSent: false };
        // The props that lock this composer are a SNAPSHOT too, and `send()` read them before the
        // pre-flight's round-trip. A pane that died or a device that lost write access inside that
        // window leaves the composer rendered locked while this burst is still queued behind an
        // await — and unlike every other key this component sends, the burst does not go through
        // `pressKeys`, which refuses when locked. Re-read the live value instead of the closure's.
        if (isLocked()) {
          return {
            ok: false as const,
            error: "Pane is no longer writable — nothing was sent",
          };
        }
        // Overshoot well past the snapshotted length: the count comes from the LAST-POLLED line, so
        // anything the host typed inside the poll gap (~1.5s) isn't counted. Extra Backspace on an
        // already-empty input is a no-op, so a generous margin costs nothing and shrinks the window
        // where a mid-gap host burst leaves a remnant that corrupts the send.
        const clearCount = [...terminalLine].length + 32;
        // BOUND to the prompt row the pre-flight's read actually saw. Ordering is not a freshness
        // bound: the read's answer describes the pane at the moment the BRIDGE snapshotted it, and
        // these keys go out when the answer arrives — a whole network round-trip later, capped only
        // by GET_TIMEOUT_MS. `expected_prompt` hands the last word to the bridge, which re-reads the
        // pane immediately before send_keys and 409s (`prompt_changed`) when that row has gone, so
        // the window shrinks to two local RPCs. Same mitigation every dialog tap gets from
        // lib/dialog-guard.ts, which is the one place in this app that could already refuse a key on
        // exactly the evidence this burst used to accept.
        const clearRes = await sendKeys(
          paneId,
          ["ctrl+k", ...Array(clearCount).fill("Backspace")],
          promptRegion ?? undefined,
        );
        if (!clearRes.ok) {
          // A refused binding is the guard doing its job, not a transport failure — say so, because
          // the user's next move is to look at the pane rather than to retry into whatever is now
          // on it. Nothing was typed either way: this aborts the send before the reply text.
          if (clearRes.code === "prompt_changed") {
            return {
              ok: false as const,
              error:
                "The input box changed while clearing it — nothing was typed. Check the pane.",
            };
          }
          return {
            ok: false as const,
            error: clearRes.error ?? "Couldn't clear the terminal input",
          };
        }
        onKeysSent();
        await sleep(TUI_SETTLE_MS);
        // `keysSent` — the burst plus this settle is exactly the window the guard re-reads across
        // before it types, so the message doesn't follow the keys into a dialog that opened inside
        // it.
        return { ok: true as const, keysSent: true };
      },
    });
    if (res.status === "sent")
      return result(true, { text: "Sent ✓", tone: "success" }, deps.isDraft, t);
    if (res.status === "blocked")
      return result(
        false,
        { text: `${res.error} Tap Send again to type anyway.`, tone: "error" },
        false,
        null,
        true,
        res.noEcho !== undefined ? { prompt: res.noEcho, typed: false } : null,
      );
    return result(
      false,
      { text: res.error, tone: "error" },
      false,
      null,
      false,
      res.status === "stalled" && res.noEcho !== undefined
        ? { prompt: res.noEcho, typed: true }
        : null,
    );
  } catch (e) {
    return result(false, {
      text: e instanceof Error ? e.message : String(e),
      tone: "error",
    });
  }
}
