import { SILENT_AUDIT, type AuditDetail, type AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "./pane-queue.ts";
import { paneReadMatches, paneReadSpec } from "./pane-read-routes.ts";
import { bracketedPasteChunks, sendKeysPaced, sendReplySteps, type SleepFn } from "./pane-write-routes.ts";
import { json, requireJsonBody, text } from "./responses.ts";
import { effectiveSettings } from "./runtime-settings.ts";
import type { AgentView, StateEngine } from "./state-engine.ts";
import { parseLines } from "../shared/harness/blocks.ts";
import { runGuardedSend, type GuardedSendIo, type ReplyOutcome, type WriteResult } from "../shared/harness/guarded-send.ts";
import { composerFor, type ComposerKit } from "../shared/harness/composer-kit.ts";
import type { StyledLine } from "../shared/harness/blocks.ts";

// POST /api/pane/:id/send — the free-text reply, guarded, in one request (spec 24).
//
// The guard (web/src/lib/guarded-send.ts) used to run in the browser, where each of its six-plus
// steps was a phone↔bridge round trip: 1.5–2 s on mobile data for an ordinary send. Here every read
// is a local Herdr call (~15 ms), so it polls ten times as often inside the same time budget. Same
// code, same invariants (collie#34): nothing is typed into a screen with no composer, destructive
// keys go only after a read saw the composer, and the submit key only after a read saw our text.

/** Verification reads: every 100 ms, 28 times. The same 2.8 s budget the browser had (8 × 350 ms). */
export const BRIDGE_POLL_DELAY_MS = 100;
export const BRIDGE_POLL_ATTEMPTS = 28;
/** Settle after clearing a stranded draft, before the re-confirming read (as the browser did). */
const SWEEP_SETTLE_MS = 350;
/**
 * Backspaces past the draft's length. The browser added 32 to cover what the host typed since its
 * last poll; this read is milliseconds old, so a small margin covers a wrapped or windowed count.
 * The cap is the browser's: each key is one paced Herdr write.
 */
const SWEEP_MARGIN = 8;
const SWEEP_MAX = 96;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The keys that clear a stranded draft: kill to the end, then Backspace over the rest. */
export function sweepKeys(draft: string): string[] {
  const count = Math.min([...draft].length + SWEEP_MARGIN, SWEEP_MAX);
  return ["ctrl+k", ...Array<string>(count).fill("Backspace")];
}

const writeResult = (outcome: { ok: true } | { ok: false; error: string }): WriteResult =>
  outcome.ok ? { ok: true } : { ok: false, error: outcome.error };

/** Which pane to send to. With `terminalId`, a pane whose terminal changed (a reused pane) is not it. */
export interface GuardedSendTarget {
  paneId: string;
  terminalId?: string;
}

export type GuardedSendResult =
  /** The bridge's own snapshot has no such pane (or it now holds another terminal). Nothing was sent. */
  | { kind: "no-pane" }
  /** Another write held the pane past `PANE_QUEUE_TIMEOUT_MS`. Nothing was sent. */
  | { kind: "busy" }
  | { kind: "done"; outcome: ReplyOutcome; swept: number };

export interface GuardedSendOptions {
  force?: boolean;
  audit?: AuditLog;
}

/**
 * The guarded send core with the bridge's I/O, shared by `POST /api/pane/:id/send` and the v2
 * dispatcher (T06), so both run one function.
 */
export interface GuardedSender {
  send(target: GuardedSendTarget, text: string, opts?: GuardedSendOptions): Promise<GuardedSendResult>;
  /**
   * One read of the pane, in its own queue turn: is the harness's composer on screen? True when the
   * harness has no `composerReady` (nothing can tell; the send's own guard decides). Null: no pane.
   */
  composerReady(target: GuardedSendTarget): Promise<boolean | null>;
  /**
   * Run `fn` in the pane's write-queue turn with the same ANSI read the guard uses and the harness's
   * composer kit (T08's mode switch reads, presses and re-reads inside one turn).
   */
  withPane<T>(target: GuardedSendTarget, fn: (pane: PaneSession) => Promise<T>): Promise<PaneTurn<T>>;
}

/** One pane, inside its write-queue turn. */
export interface PaneSession {
  paneId: string;
  /** The harness's composer kit; undefined for a shell or a harness with no adapter. */
  kit: ComposerKit | undefined;
  /** One fresh read of the pane, parsed (the guard's read: same source, lines and `ansi` format). */
  read(): Promise<StyledLine[]>;
}

export type PaneTurn<T> = { kind: "no-pane" } | { kind: "busy" } | { kind: "done"; value: T };

function findPane(engine: Pick<StateEngine, "current">, target: GuardedSendTarget): AgentView | null {
  const { agents, shellPanes } = engine.current();
  const pane = agents.find((p) => p.paneId === target.paneId) ?? shellPanes.find((p) => p.paneId === target.paneId);
  if (!pane) return null;
  if (target.terminalId && pane.terminalId && pane.terminalId !== target.terminalId) return null;
  return pane;
}

export function createGuardedSender(
  herdr: HerdrClient,
  cfg: Config,
  engine: Pick<StateEngine, "current">,
  queue: PaneQueue,
  sleep: SleepFn = defaultSleep,
): GuardedSender {
  const readerFor = (pane: AgentView) => {
    const read = paneReadSpec(pane, effectiveSettings(cfg).readLines);
    return async (): Promise<string> => {
      const got = await herdr.readPane(pane.paneId, read.source, read.lines, "ansi");
      if (!paneReadMatches(pane.paneId, got)) throw new Error("pane read mismatch");
      return got.text;
    };
  };

  return {
    async send(target, sent, opts = {}) {
      // The bridge's own view of the pane decides the harness, never the client's.
      const pane = findPane(engine, target);
      if (!pane) return { kind: "no-pane" };
      const paneId = pane.paneId;
      const kit = pane.kind === "shell" ? undefined : composerFor(pane.agent);
      const force = opts.force === true;
      const settings = effectiveSettings(cfg);
      const io: GuardedSendIo = {
        read: readerFor(pane),
        type: async (t, paste) => writeResult(await sendReplySteps(herdr, paneId, paste ? bracketedPasteChunks(t) : t, false, [], sleep)),
        submit: async (keys) => writeResult(await sendReplySteps(herdr, paneId, "", true, keys ?? settings.submitKeys, sleep)),
        oneShot: async (t) => writeResult(await sendReplySteps(herdr, paneId, t, true, settings.submitKeys, sleep)),
        sleep,
        pollAttempts: BRIDGE_POLL_ATTEMPTS,
        pollDelayMs: BRIDGE_POLL_DELAY_MS,
      };

      let swept = 0;
      let outcome: ReplyOutcome;
      try {
        // The whole guard holds the pane's write queue: no keys or reply can land between its steps.
        outcome = await queue.run(paneKey(paneId), () =>
          runGuardedSend(kit, io, {
            text: sent,
            force,
            // Runs only after a live read positively saw the composer, never under `force` (the core
            // enforces both). The draft comes from that same read, so it is sized exactly.
            onComposerSeen: async ({ draft }) => {
              if (draft === null || draft.trim() === "") return { ok: true, keysSent: false };
              const keys = sweepKeys(draft);
              try {
                await sendKeysPaced(herdr, paneId, keys, sleep);
              } catch {
                return { ok: false, error: "Couldn't clear the terminal input — nothing was typed." };
              }
              swept = keys.length;
              await sleep(SWEEP_SETTLE_MS);
              return { ok: true, keysSent: true };
            },
          }),
        );
      } catch (err) {
        if (!(err instanceof PaneBusyError)) throw err;
        return { kind: "busy" };
      }

      const detail: AuditDetail = { text: sent, status: outcome.status };
      if (force) detail.force = true;
      if (swept > 0) detail.swept = swept;
      if (outcome.status === "error" && outcome.textDelivered) detail.textDelivered = true;
      (opts.audit ?? SILENT_AUDIT).record({ action: "send", paneId, detail });
      return { kind: "done", outcome, swept };
    },

    async withPane(target, fn) {
      const pane = findPane(engine, target);
      if (!pane) return { kind: "no-pane" };
      const kit = pane.kind === "shell" ? undefined : composerFor(pane.agent);
      const read = readerFor(pane);
      try {
        const value = await queue.run(paneKey(pane.paneId), () =>
          fn({ paneId: pane.paneId, kit, read: async () => parseLines(await read()) }),
        );
        return { kind: "done", value };
      } catch (err) {
        if (err instanceof PaneBusyError) return { kind: "busy" };
        throw err;
      }
    },

    async composerReady(target) {
      const pane = findPane(engine, target);
      if (!pane) return null;
      const kit = pane.kind === "shell" ? undefined : composerFor(pane.agent);
      if (!kit?.composerReady) return true;
      const ready = kit.composerReady.bind(kit);
      const read = readerFor(pane);
      return queue.run(paneKey(pane.paneId), async () => {
        try {
          return ready(parseLines(await read()));
        } catch {
          return false;
        }
      });
    },
  };
}

export async function guardedSendPane(
  herdr: HerdrClient,
  cfg: Config,
  engine: StateEngine,
  paneId: string,
  req: Request,
  queue: PaneQueue,
  audit: AuditLog = SILENT_AUDIT,
  sleep: SleepFn = defaultSleep,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { text?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  if (typeof body.text !== "string" || body.text.trim() === "") return text("bad text", 400);
  if (body.force !== undefined && typeof body.force !== "boolean") return text("bad force", 400);
  const ae = req.headers.get("accept-encoding");

  const result = await createGuardedSender(herdr, cfg, engine, queue, sleep).send({ paneId }, body.text, {
    force: body.force === true,
    audit,
  });
  if (result.kind === "no-pane") return text("no such pane", 404);
  if (result.kind === "busy") {
    const outcome: ReplyOutcome = { status: "error", error: "Another write to this pane is still running. Nothing was typed." };
    const detail: AuditDetail = { text: body.text, status: outcome.status };
    if (body.force === true) detail.force = true;
    audit.record({ action: "send", paneId, detail });
    return json(outcome, ae);
  }
  return json(result.outcome, ae);
}
