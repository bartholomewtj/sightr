/**
 * The composer's pure rules (T12), the way T3 keeps `composerDispatch.ts` and `composerSubmission.ts`
 * beside ChatComposer: what the primary button is, what a key press does, when the slash menu opens.
 * No React and no stores, so every row of the spec's button table is a plain test.
 */
import type { ChatAttachment, QueuedMessage, Run, RuntimeRequestOption, Thread, TurnItem } from "@shared/v2/contracts";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";

import type { EnterMode, FollowUp } from "@/state/composer";

/** The bridge's longest dispatch (`MAX_DISPATCH_CHARS` in bridge/threads/dispatch.ts). */
export const MAX_COMPOSER_CHARS = 64 * 1024;
/** A paste this long asks "Attach as a file instead?" rather than going into the box. */
export const LARGE_PASTE_CHARS = 32 * 1024;

export type PrimaryKind = "send" | "queue" | "steer" | "stop" | "update";

export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  disabled: boolean;
  /** Why it is disabled, said beside the button. */
  reason: string | null;
}

export interface ComposerButtons {
  primary: PrimaryAction;
  /** A Stop button beside Queue/Steer. */
  stop: boolean;
  /** The request panel is shown; the box stays beside it (T37), and its primary queues. */
  requestPanel: boolean;
}

export interface ButtonInput {
  thread: Pick<Thread, "status" | "shelf" | "capabilities"> | null;
  /** The thread has a pending runtime request this client can show. */
  hasRequest: boolean;
  hasText: boolean;
  followUp: FollowUp;
  /** Ctrl/⌘ held (T3's alternate modifier): Queue and Steer swap. */
  alternate: boolean;
  editing: boolean;
  /** A command is waiting for its reply. */
  busy: boolean;
  linkLost: boolean;
  readOnly: boolean;
  uploading: boolean;
  /**
   * False while the open run cannot take steering input (it started from `/compact`): a follow-up
   * queues whatever the setting or the modifier says (T3 #20184). Default true.
   */
  canSteer?: boolean;
}

const disabledSend = (reason: string | null, label = "Send"): PrimaryAction => ({ kind: "send", label, disabled: true, reason });

/** Can this thread queue a follow-up, and can it steer one (T01: steer needs both flags). */
export function followUpCapabilities(caps: Thread["capabilities"] | undefined): { queue: boolean; steer: boolean } {
  const queue = caps?.canQueueDrain === true;
  return { queue, steer: queue && caps?.canInterrupt === true };
}

/**
 * The send mode while the agent works, after the setting, the modifier, the thread's capabilities
 * and whether the open run can take steering now (`canSteer`, false during `/compact`).
 */
export function workingMode(
  followUp: FollowUp,
  alternate: boolean,
  caps: Thread["capabilities"] | undefined,
  canSteer = true,
): "queue" | "steer" | null {
  const can = followUpCapabilities(caps);
  const wanted = resolveComposerDispatchMode({ running: true, activeTurnDefault: followUp, alternateModifier: alternate, canSteer });
  if (wanted === "steer" && can.steer) return "steer";
  if (can.queue) return "queue";
  return null;
}

/** The spec's button table. Its state comes from the thread and the queue, never from the text alone. */
export function resolveComposerButtons(input: ButtonInput): ComposerButtons {
  const none = { stop: false, requestPanel: false };
  const { thread } = input;
  if (input.hasRequest) {
    // T37 (T3 #21503): the agent asks, but the box stays usable. A send here is a queued message:
    // `start`/`steer` are refused by the bridge while a dialog is open (`needs-response`), and a
    // steer's interrupt key would cancel the dialog. The request is never answered or declined by a
    // send; the queue drains once the operator answers and the run rests.
    const canQueue = followUpCapabilities(input.thread?.capabilities).queue;
    if (!canQueue) return { ...none, primary: disabledSend("Answer the agent above."), requestPanel: true };
    return {
      primary: {
        kind: "queue",
        label: "Queue",
        disabled: input.busy || input.uploading,
        reason: input.uploading
          ? "Waiting for uploads…"
          : input.hasText
            ? "The agent is asking; your message waits in the queue."
            : "The agent is asking; type a message to queue it.",
      },
      stop: false,
      requestPanel: true,
    };
  }
  if (!thread) return { ...none, primary: disabledSend("Loading the thread…") };
  if (thread.shelf === "archived") return { ...none, primary: disabledSend("The pane is gone.") };
  if (input.readOnly) return { ...none, primary: disabledSend("This device is read-only.") };
  if (input.linkLost) return { ...none, primary: disabledSend("Not connected. Sending is paused.") };

  if (input.editing) {
    return {
      ...none,
      primary: {
        kind: "update",
        label: "Update",
        disabled: input.busy || !input.hasText,
        reason: input.hasText ? null : "A queued message cannot be empty.",
      },
    };
  }

  const caps = thread.capabilities;
  switch (thread.status) {
    case "working": {
      const canStop = caps.canInterrupt;
      if (!input.hasText) {
        if (canStop) return { ...none, primary: { kind: "stop", label: "Stop", disabled: false, reason: null } };
        return { ...none, primary: disabledSend("The agent is working.") };
      }
      const canSteer = input.canSteer !== false;
      const mode = workingMode(input.followUp, input.alternate, caps, canSteer);
      if (mode === null) {
        // A plain shell thread: no queue, no steer. Stop alone, or nothing.
        if (canStop) return { ...none, primary: { kind: "stop", label: "Stop", disabled: false, reason: null } };
        return { ...none, primary: disabledSend("The agent is working. Wait for it to finish.") };
      }
      const label = mode === "queue" ? "Queue" : "Steer";
      return {
        primary: {
          kind: mode,
          label,
          disabled: input.busy || input.uploading,
          reason: input.uploading
            ? "Waiting for uploads…"
            : !canSteer && followUpCapabilities(caps).steer
              ? "Compacting. Your message waits in the queue."
              : null,
        },
        stop: canStop,
        requestPanel: false,
      };
    }
    case "approval":
    case "input":
      // The status says a dialog is up but no request reached this client yet.
      return { ...none, primary: disabledSend("The agent is waiting for an answer in the terminal.") };
    case "starting":
      return { ...none, primary: disabledSend("The agent is starting.") };
    default:
      // idle, done, failed
      return {
        ...none,
        primary: {
          kind: "send",
          label: "Send",
          disabled: !input.hasText || input.busy || input.uploading,
          reason: input.uploading ? "Waiting for uploads…" : null,
        },
      };
  }
}

// ── Compaction ──────────────────────────────────────────────────────────────────────────────────

/**
 * A harness command that cannot take steering input: an interrupt during it cancels it. T3's
 * `isNativeMaintenanceCommand` (apps/server/src/orchestration-v2/CommandPolicy.ts @ db5919d87); the
 * bridge applies the same rule (bridge/threads/queue-drain.ts).
 */
export function isNativeMaintenanceCommand(message: { text: string; attachments?: readonly ChatAttachment[] }): boolean {
  return (message.attachments ?? []).length === 0 && ["/compact", "/logout"].includes(message.text.trim().toLowerCase());
}

/**
 * Is the thread compacting: its newest run is `running` and started from a maintenance command
 * (T3's `isCompacting`, which feeds `canSteer: !isCompacting`). The run's message is its
 * `userItemId`, else a `user_message` attributed to it, else the newest one no run has claimed yet.
 * Sightr: or the bridge read the harness compacting on its own (`thread.compacting`, auto-compact).
 */
export function isCompacting(
  state: { runs: Record<string, Run>; items: Record<string, TurnItem>; thread?: Pick<Thread, "compacting"> | null } | null | undefined,
): boolean {
  if (!state) return false;
  if (state.thread?.compacting === true) return true;
  let latest: Run | null = null;
  for (const run of Object.values(state.runs)) if (!latest || run.ordinal > latest.ordinal) latest = run;
  if (!latest || latest.status !== "running") return false;
  const run = latest;
  type UserItem = Extract<TurnItem, { type: "user_message" }>;
  const users = Object.values(state.items).filter((i): i is UserItem => i.type === "user_message");
  const linked = run.userItemId ? state.items[run.userItemId] : undefined;
  const message =
    (linked?.type === "user_message" ? linked : undefined) ??
    users.find((i) => i.runId === run.id) ??
    users.filter((i) => i.runId === null).sort((a, b) => a.createdAt - b.createdAt || a.ordinal - b.ordinal).at(-1);
  if (!message || (message.runId !== null && message.runId !== run.id)) return false;
  return isNativeMaintenanceCommand(message);
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────

export type KeyAction = "submit" | "submit-alternate" | "steer-oldest" | "newline" | null;

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * What a key press in the box does. IME composition (and Safari's keyCode 229) never sends.
 * - `enter` mode: Enter sends, Shift+Enter adds a line, Mod+Enter sends the other follow-up (T3).
 * - `mod-enter` mode: Enter adds a line, Mod+Enter sends, Mod+Alt+Enter sends the other follow-up.
 * - Mod+Shift+Enter steers the oldest queued message, in both modes.
 */
export function resolveEnterAction(e: KeyLike, mode: EnterMode): KeyAction {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key !== "Enter") return null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey) return "steer-oldest";
  if (mode === "enter") {
    if (e.shiftKey) return "newline";
    return mod ? "submit-alternate" : "submit";
  }
  if (!mod) return "newline";
  return e.altKey ? "submit-alternate" : "submit";
}

/**
 * The Enter mode in force: the stored choice, else the device default. A touch screen defaults to
 * `mod-enter` (Enter is a newline, the button sends) even at a desktop-wide layout (a tablet), so a
 * soft keyboard's Enter or a dictated line break never sends half a message.
 */
export function enterModeFor(stored: EnterMode | null, layout: "desktop" | "phone", coarsePointer: boolean): EnterMode {
  if (stored) return stored;
  return layout === "desktop" && !coarsePointer ? "enter" : "mod-enter";
}

/**
 * The box's tallest autosize: `lines` lines plus its padding, or the CSS `max-height` (a dvh cap, so
 * the box shrinks when the keyboard leaves little room) when that is lower. NaN inputs fall back.
 */
export function composerMaxHeight(lineHeight: number, lines: number, cssMaxHeight: number): number {
  const byLines = (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20) * lines + 16;
  return Number.isFinite(cssMaxHeight) && cssMaxHeight > 0 ? Math.min(byLines, cssMaxHeight) : byLines;
}

/** Should Alt+ArrowUp open the newest queued message for editing (empty box, caret at the start). */
export function wantsEditNewest(e: KeyLike, text: string, caret: number): boolean {
  return e.key === "ArrowUp" && e.altKey && !e.ctrlKey && !e.metaKey && text === "" && caret === 0;
}

// ── Slash menu ──────────────────────────────────────────────────────────────────────────────────

/** The query when the box is a bare `/command` being typed (a `/` at the start, no space yet). */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]! : null;
}

// ── Paste ───────────────────────────────────────────────────────────────────────────────────────

export function isLargePaste(text: string): boolean {
  return text.length >= LARGE_PASTE_CHARS;
}

// ── Queue rows ──────────────────────────────────────────────────────────────────────────────────

/** Why a queued message is held, in the operator's words. */
export function heldReasonText(reason: string | undefined): string {
  switch (reason) {
    case "restart":
      return "Paused after restart";
    case "pane-closed":
    case "pane-gone":
      return "Not sent: pane closed";
    case "interrupt-failed":
      return "Not sent: the agent could not be stopped";
    case "interrupt-timeout":
      return "Not sent: the agent did not stop in time";
    case "blocked":
    case "stalled":
    case "error":
      return "Held after failed sends";
    case "busy":
      return "Held: the pane was busy";
    default:
      return reason ? `Held: ${reason}` : "Held";
  }
}

/**
 * The notice for a queue a bridge restart put back on its own (Phase 5.3): what happened, in the
 * operator's words, with how many messages it concerned when this client saw them held.
 */
export function queueAutoResumeText(count: number): string {
  if (count === 1) return "A queued message resumed automatically after the restart.";
  if (count > 1) return `${count} queued messages resumed automatically after the restart.`;
  return "Queued messages resumed automatically after the restart.";
}

/** The queue's header line: "Paused after restart" when every held row says so. */
export function queueHeldSummary(queue: readonly QueuedMessage[]): { held: boolean; restart: boolean; resumable: boolean } {
  const held = queue.filter((q) => q.state === "held");
  const resumable = held.some((q) => q.heldReason !== "pane-closed" && q.heldReason !== "pane-gone");
  return {
    held: held.length > 0,
    restart: held.length > 0 && held.every((q) => q.heldReason === "restart"),
    resumable,
  };
}

/** First line of a message, for a queue row. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.trim() || text.trim();
}

// ── Request options ─────────────────────────────────────────────────────────────────────────────

/**
 * Options in display order with their bridge index: a destructive option is never the first button
 * (and never takes focus), so they move to the end. Order otherwise stays as the dialog had it.
 */
export function orderRequestOptions(options: readonly RuntimeRequestOption[]): { option: RuntimeRequestOption; index: number }[] {
  const indexed = options.map((option, index) => ({ option, index }));
  return [...indexed.filter((o) => !o.option.destructive), ...indexed.filter((o) => o.option.destructive)];
}

// ── Permission mode (T08's live switch) ─────────────────────────────────────────────────────────

/** One choice in the composer's mode menu: an id from the thread's capabilities, its label from the launch table. */
export interface PermissionModeOption {
  id: string;
  label: string;
  /** The chip's one-word name on a phone ("Edits"); the menu and the aria-label keep `label`. */
  short: string;
  /** Needs a confirm step and `confirmBypass` (the bridge refuses it otherwise). */
  destructive: boolean;
}

/**
 * The modes the thread can switch to live, in the capability list's order, or null when it cannot
 * switch (no flag, or no list). Labels and the destructive mark come from the harness's launch modes;
 * an id the launch table does not name keeps its id as the label.
 */
export function permissionModeOptions(
  caps: Thread["capabilities"] | undefined,
  launchModes: readonly { id: string; label: string; short?: string; destructive?: boolean }[] | null | undefined,
): PermissionModeOption[] | null {
  if (!caps?.canSwitchPermissionMode) return null;
  const ids = caps.permissionModes ?? [];
  if (ids.length === 0) return null;
  return ids.map((id) => {
    const known = launchModes?.find((m) => m.id === id);
    const label = known?.label ?? id;
    return { id, label, short: known?.short ?? label, destructive: known?.destructive === true };
  });
}

/**
 * Why the mode cannot change right now, or null when it can. The bridge switches only a resting
 * thread (idle or done) with nothing waiting on the operator; this says so before a tap, not after.
 */
export function permissionModeBlock(input: {
  thread: Pick<Thread, "status" | "shelf"> | null;
  hasRequest: boolean;
  busy: boolean;
  readOnly: boolean;
  linkLost: boolean;
}): string | null {
  const { thread } = input;
  if (!thread) return "Loading the thread…";
  if (thread.shelf === "archived") return "The pane is gone.";
  if (input.readOnly) return "This device is read-only.";
  if (input.linkLost) return "Not connected.";
  if (input.hasRequest || thread.status === "approval" || thread.status === "input") return "Answer the agent first.";
  if (input.busy) return "Wait for the last command to finish.";
  switch (thread.status) {
    case "idle":
    case "done":
      return null;
    case "working":
      return "The agent is working. Change the mode when it stops.";
    case "starting":
      return "The agent is starting.";
    default:
      return "The agent is not at its prompt.";
  }
}

/**
 * The operator's words for a refused `thread.permissionMode.set` (bridge/threads/live-modes.ts codes).
 * `shown` is the mode the footer last showed when keys went out; `labelOf` names it.
 */
export function permissionModeRefusalText(error: string | undefined, shown: string | undefined, labelOf: (id: string) => string): string {
  const now = shown ? ` It is now in ${labelOf(shown)}.` : "";
  switch (error) {
    case "thread-busy":
      return "The agent is working. Change the mode when it stops.";
    case "needs-response":
      return "The agent is waiting for an answer first.";
    case "thread-archived":
    case "pane-gone":
      return "The pane is gone.";
    case "permission-mode-unsupported":
      return "This agent's mode cannot be changed from Sightr.";
    case "invalid-mode":
      return "The bridge does not know that mode.";
    case "bypass-needs-confirm":
      return "The bridge needs the bypass confirmed.";
    case "blocked":
      return `The agent's input box was not on screen, so Sightr stopped.${now || " Nothing changed."}`;
    case "unknown-mode":
      return `Sightr could not read the mode from the agent's footer.${now} Check the Terminal.`;
    case "mode-not-reached":
      return `The mode did not come up after cycling.${now}`;
    case "bypass-reached":
      return `Sightr stopped at Bypass permissions on the way and pressed nothing more.${now} Pick a mode again.`;
    default:
      return error ? `The mode did not change: ${error}.` : "The mode did not change.";
  }
}

// ── Prompt length ───────────────────────────────────────────────────────────────────────────────

/** The line under the box once the text reaches the cap (the box stops taking more there). */
export function promptLengthMessage(text: string, max = MAX_COMPOSER_CHARS): string | null {
  return text.length >= max ? `At the ${Math.round(max / 1024)} KB limit. Attach longer text as a file.` : null;
}

// ── Status line ─────────────────────────────────────────────────────────────────────────────────

/** "just now", "12m ago", "3h ago", "2d ago". */
export function agoLabel(at: number, now: number): string {
  const ms = now - at;
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export type ThreadStatusLineState =
  | { kind: "snoozed"; label: string; actionLabel: "Wake now"; command: "thread.unsnooze" }
  | { kind: "settled"; label: string; actionLabel: "Un-settle"; command: "thread.unsettle" };

/**
 * T3's ThreadStatusLine rows that Sightr has data for: a snoozed thread (wakes in …) and a settled one
 * (settled … ago). Sightr keeps no "woke from snooze" acknowledgement, so that row is not here.
 */
export function threadStatusLine(
  thread: Pick<Thread, "shelf" | "snoozedUntil" | "settledAt"> | null,
  now: number,
  wakeLabel: (until: number, now: number) => string,
): ThreadStatusLineState | null {
  if (!thread) return null;
  if (thread.shelf === "snoozed" && thread.snoozedUntil !== undefined && thread.snoozedUntil > now) {
    return { kind: "snoozed", label: `Snoozed, wakes in ${wakeLabel(thread.snoozedUntil, now)}`, actionLabel: "Wake now", command: "thread.unsnooze" };
  }
  if (thread.shelf === "settled") {
    const label = thread.settledAt !== undefined ? `Settled ${agoLabel(thread.settledAt, now)}` : "Settled";
    return { kind: "settled", label, actionLabel: "Un-settle", command: "thread.unsettle" };
  }
  return null;
}
