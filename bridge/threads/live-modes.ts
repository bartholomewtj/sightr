import { MODEL_PATTERN } from "../../shared/agents.ts";
import type { CommandOf } from "../../shared/v2/contracts.ts";
import { SILENT_AUDIT, type AuditLog } from "../audit.ts";
import type { GuardedSender, GuardedSendTarget, PaneSession } from "../guarded-send-route.ts";
import type { HerdrClient } from "../herdr-client.ts";
import type { StyledLine } from "../../web/src/lib/blocks.ts";
import type { ComposerKit } from "../../web/src/lib/harness/composer-kit.ts";
import { sendKeysPaced, type SleepFn } from "../pane-write-routes.ts";
import { failureText } from "../responses.ts";
import type { EventDraft, ServerThread } from "./events.ts";
import { isSettled, type QueueDrainer } from "./queue-drain.ts";
import type { ThreadStore } from "./store.ts";
import type { EffectContext, EffectHandler, EffectOutcome, EffectRegistry } from "./v2-routes.ts";

// Live mode switches (T08): `thread.permissionMode.set` and `thread.model.set`, as T05 effect
// handlers. Neither reads a harness id: the thread's capability flags say whether the harness can do
// it, and the harness's composer kit reads its footer.
//
// - permission mode: in one pane write-queue turn, read the footer, press the cycle key, re-read, and
//   stop on the target. No key goes out unless the read just before it showed the composer, and the
//   loop never stops on or passes bypass unless bypass is the confirmed target.
// - model: `${modelCommand} ${model}` through the guarded send (T06's start path), never around it.

/** The key that cycles a harness's permission mode. */
export const MODE_CYCLE_KEY = "shift+tab";
/** More than the longest known cycle (Claude: auto → manual → accept edits → plan, plus bypass). */
export const MAX_PRESSES = 6;
/** How long the footer gets to repaint after a press before the re-read. */
export const MODE_SETTLE_MS = 250;
export const BYPASS_MODE = "bypassPermissions";

export interface LiveModeDeps {
  store: Pick<ThreadStore, "append" | "getThread" | "pendingRequests" | "now">;
  sender: Pick<GuardedSender, "send" | "withPane">;
  herdr: Pick<HerdrClient, "sendPaneKeys" | "sendPaneText">;
  /** T06's drainer: a switch marks the thread as sending so a queued row cannot interleave. */
  drainer?: Pick<QueueDrainer, "beginSend"> | null;
  audit?: AuditLog;
  sleep?: SleepFn;
  settleMs?: number;
}

const refuse = (
  status: number,
  code: Extract<EffectOutcome, { ok: false }>["code"],
  error: string,
  extra: { afterWork?: boolean; shown?: string; threadId?: string } = {},
): EffectOutcome => ({ ok: false, status, code, error, ...extra });
const conflict = (why: string) => refuse(409, "conflict", why);
const invalid = (why: string) => refuse(400, "invalid", why);

/** What one turn of the cycle loop came to. */
type CycleResult =
  | { kind: "reached"; presses: number }
  /** Refused before any key went out. */
  | { kind: "refused"; reason: "unsupported" | "blocked" | "unknown-mode" }
  /** Stopped after `presses` keys; `shown` is the footer's mode at the stop, when it could be read. */
  | { kind: "stopped"; reason: "mode-not-reached" | "bypass-reached" | "blocked" | "unknown-mode"; presses: number; shown?: string }
  | { kind: "key-failed"; presses: number; error: unknown };

/** The mode a footer read shows, with the kit's default for a footer that prints none. */
function modeOn(pane: PaneSession, lines: StyledLine[]): string | null {
  const kit = pane.kit;
  if (!kit?.permissionModeOf) return null;
  return kit.permissionModeOf(lines) ?? kit.defaultModeId ?? null;
}

/**
 * The mode a resting pane's screen shows, or null when it cannot tell: no reader, no composer on
 * screen (a dialog or menu is up), or no mode row and no kit default. The mode watch (mode-watch.ts)
 * records it; the same reader as the cycle, so the two never judge one footer two ways.
 */
export function modeOnScreen(kit: ComposerKit, lines: StyledLine[]): string | null {
  if (!kit.permissionModeOf || !kit.composerReady?.(lines)) return null;
  return kit.permissionModeOf(lines) ?? kit.defaultModeId ?? null;
}

/** A kit that cannot tell whether its composer is up never gets a key from here. */
const composerShown = (pane: PaneSession, lines: StyledLine[]): boolean =>
  pane.kit?.composerReady ? pane.kit.composerReady(lines) : false;

export function createLiveModes(deps: LiveModeDeps): { effects: EffectRegistry } {
  const { store, sender, herdr } = deps;
  const audit = deps.audit ?? SILENT_AUDIT;
  const sleep: SleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const settleMs = deps.settleMs ?? MODE_SETTLE_MS;

  const target = (thread: ServerThread): GuardedSendTarget => ({
    paneId: thread.paneId,
    ...(thread.terminalId ? { terminalId: thread.terminalId } : {}),
  });

  /** Why a thread cannot be switched now: it must rest with nothing waiting on the operator. */
  const notSettled = (thread: ServerThread): EffectOutcome | null => {
    if (thread.shelf === "archived") return conflict("thread-archived");
    const open = store.pendingRequests().some((r) => r.threadId === thread.id);
    if (open || thread.status === "approval" || thread.status === "input") return conflict("needs-response");
    if (!isSettled(thread.status)) return conflict("thread-busy");
    return null;
  };

  const commit = (events: EventDraft[], ctx: EffectContext, threadId: string): EffectOutcome => {
    const { last } = store.append(events, { commandId: ctx.commandId, receipt: ctx.receipt });
    return { ok: true, sequence: last, threadId };
  };

  const modePatch = (thread: ServerThread, mode: string): EventDraft[] =>
    thread.permissionMode === mode
      ? []
      : [{ type: "thread.updated", threadId: thread.id, payload: { patch: { permissionMode: mode }, at: store.now() } }];

  /** Read, press, re-read until the footer shows `want`. Runs inside the pane's queue turn. */
  const cycle = async (pane: PaneSession, want: string): Promise<CycleResult> => {
    if (!pane.kit?.permissionModeOf) return { kind: "refused", reason: "unsupported" };
    let lines = await pane.read();
    if (!composerShown(pane, lines)) return { kind: "refused", reason: "blocked" };
    let shown = modeOn(pane, lines);
    if (shown === null) return { kind: "refused", reason: "unknown-mode" };
    let presses = 0;
    while (shown !== want) {
      // Never press past bypass on the way to another mode (a press from bypass would pass it).
      if (shown === BYPASS_MODE) return { kind: "stopped", reason: "bypass-reached", presses, shown };
      if (presses >= MAX_PRESSES) return { kind: "stopped", reason: "mode-not-reached", presses, shown };
      try {
        await sendKeysPaced(herdr, pane.paneId, [MODE_CYCLE_KEY], sleep);
      } catch (error) {
        return { kind: "key-failed", presses, error };
      }
      presses++;
      await sleep(settleMs);
      lines = await pane.read();
      // A dialog came up: stop before the next key could land in it.
      if (!composerShown(pane, lines)) return { kind: "stopped", reason: "blocked", presses };
      const next = modeOn(pane, lines);
      if (next === null) return { kind: "stopped", reason: "unknown-mode", presses };
      shown = next;
    }
    return { kind: "reached", presses };
  };

  // ── thread.permissionMode.set ──

  const setPermissionMode: EffectHandler = async (command, ctx) => {
    if (command.type !== "thread.permissionMode.set") return invalid("wrong-type");
    const c = command as CommandOf<"thread.permissionMode.set">;
    if (typeof c.threadId !== "string" || c.threadId === "") return invalid("bad-threadId");
    if (typeof c.mode !== "string" || c.mode === "") return invalid("invalid-mode");
    if (c.confirmBypass !== undefined && typeof c.confirmBypass !== "boolean") return invalid("bad-confirmBypass");
    const thread = store.getThread(c.threadId);
    if (!thread) return refuse(404, "not_found", "no-such-thread");
    const caps = thread.capabilities;
    if (!caps.canSwitchPermissionMode) return refuse(409, "unsupported", "permission-mode-unsupported");
    if (!(caps.permissionModes ?? []).includes(c.mode)) return invalid("invalid-mode");
    if (c.mode === BYPASS_MODE && c.confirmBypass !== true) return invalid("bypass-needs-confirm");
    const busy = notSettled(thread);
    if (busy) return busy;

    const finish = deps.drainer?.beginSend(thread.id);
    let turn;
    try {
      turn = await sender.withPane(target(thread), (pane) => cycle(pane, c.mode));
    } finally {
      // A mode switch starts no run, so the drainer need not wait for one.
      finish?.(false);
    }
    if (turn.kind === "no-pane") return conflict("pane-gone");
    if (turn.kind === "busy") return refuse(503, "busy", "pane busy");
    const result = turn.value;
    const presses = result.kind === "refused" ? 0 : result.presses;
    if (presses > 0) {
      audit.record({
        action: "keys",
        paneId: thread.paneId,
        detail: { keys: [MODE_CYCLE_KEY], presses, permissionMode: c.mode, outcome: result.kind },
      });
    }

    switch (result.kind) {
      case "reached":
        return commit(modePatch(store.getThread(thread.id) ?? thread, c.mode), ctx, thread.id);
      case "refused":
        // Nothing was sent: no receipt, so a retry of the same id may try again.
        return result.reason === "unsupported" ? refuse(409, "unsupported", "permission-mode-unsupported") : conflict(result.reason);
      case "stopped": {
        // Keys went out: record the mode the footer last showed, then refuse with a receipt.
        if (result.shown !== undefined) {
          const patch = modePatch(store.getThread(thread.id) ?? thread, result.shown);
          if (patch.length > 0) store.append(patch, { commandId: ctx.commandId });
        }
        return refuse(409, "conflict", result.reason, {
          afterWork: true,
          threadId: thread.id,
          ...(result.shown !== undefined ? { shown: result.shown } : {}),
        });
      }
      case "key-failed":
        return refuse(502, "failed", failureText("mode key", result.error), { afterWork: result.presses > 0, threadId: thread.id });
    }
  };

  // ── thread.model.set ──

  const setModel: EffectHandler = async (command, ctx) => {
    if (command.type !== "thread.model.set") return invalid("wrong-type");
    const c = command as CommandOf<"thread.model.set">;
    if (typeof c.threadId !== "string" || c.threadId === "") return invalid("bad-threadId");
    if (typeof c.model !== "string" || !MODEL_PATTERN.test(c.model)) return invalid("invalid-model");
    const thread = store.getThread(c.threadId);
    if (!thread) return refuse(404, "not_found", "no-such-thread");
    const caps = thread.capabilities;
    if (!caps.canSwitchModel || !caps.modelCommand) return refuse(409, "unsupported", "model-unsupported");
    const busy = notSettled(thread);
    if (busy) return busy;

    const finish = deps.drainer?.beginSend(thread.id);
    let result;
    try {
      result = await sender.send(target(thread), `${caps.modelCommand} ${c.model}`, { audit });
    } finally {
      finish?.(false);
    }
    if (result.kind === "no-pane") return conflict("pane-gone");
    if (result.kind === "busy") return refuse(503, "busy", "pane busy");
    const outcome = result.outcome;
    switch (outcome.status) {
      case "sent":
        // Requested. The thread's `model` changes only when a later source (the journal) reports it.
        return commit([], ctx, thread.id);
      case "blocked":
        return refuse(409, "conflict", "blocked", { threadId: thread.id });
      case "stalled":
        return refuse(409, "conflict", "stalled", { afterWork: true, threadId: thread.id });
      case "error":
        return refuse(502, "failed", outcome.error, { afterWork: outcome.textDelivered === true, threadId: thread.id });
    }
  };

  return { effects: { "thread.permissionMode.set": setPermissionMode, "thread.model.set": setModel } };
}
