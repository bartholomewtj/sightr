import type { RuntimeRequest } from "../../shared/v2/contracts.ts";
import { SILENT_AUDIT, type AuditDetail, type AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "../pane-queue.ts";
import { checkPromptBinding, sendKeysPaced, type SleepFn } from "../pane-write-routes.ts";
import { failureText } from "../responses.ts";
import { requestEvents } from "./request-items.ts";
import type { ThreadStore } from "./store.ts";

// `runtime-request.respond` (T04; T05 routes the command here). One option of a pending request is
// answered by typing its keys, after a fresh read of the pane shows the screen the request was parsed
// from. The read and the keys happen in one pane-queue turn, so no other write lands in between, and
// the matcher is v1's (`checkPromptBinding`, shared/prompt-binding.ts), so v2 is exactly as strict.

export type RespondCode = "not_found" | "invalid" | "conflict" | "prompt-changed" | "busy" | "failed";

export type RespondResult =
  | { ok: true; sequence: number; request: RuntimeRequest }
  | { ok: false; code: RespondCode; reason: string };

export interface RespondCommand {
  requestId: string;
  optionIndex?: number;
  optionIndices?: number[];
}

export interface RespondDeps {
  store: Pick<ThreadStore, "append" | "getRequest" | "requestBoundText" | "getThread">;
  herdr: Pick<HerdrClient, "readPane" | "sendPaneKeys" | "sendPaneText">;
  cfg: Config;
  queue: PaneQueue;
  audit?: AuditLog;
  now?: () => number;
  sleep?: SleepFn;
  /** Called after a request resolves, with the request as committed. */
  onResolved?: (request: RuntimeRequest) => void;
}

export interface RespondOptions {
  commandId?: string;
  /** What the success receipt stores (T05 keeps the command's body hash there). */
  receiptResult?: unknown;
}

export type RespondHandler = (command: RespondCommand, opts?: RespondOptions) => Promise<RespondResult>;

const fail = (code: RespondCode, reason: string): RespondResult => ({ ok: false, code, reason });

/** Why `request` cannot take `optionIndex`, or null when it can. */
function invalidAnswer(request: RuntimeRequest, command: RespondCommand): RespondResult | null {
  if (request.via === "whistlr") return fail("invalid", "whistlr-card");
  if (command.optionIndices !== undefined) return fail("invalid", "multi-select-unsupported");
  if (request.options.length === 0) return fail("invalid", request.kind === "password" ? "password" : "no-options");
  const i = command.optionIndex;
  if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= request.options.length) {
    return fail("invalid", "bad-option");
  }
  if (request.options[i]!.keys.length === 0) return fail("invalid", "no-keys");
  return null;
}

export function createRespondHandler(deps: RespondDeps): RespondHandler {
  const { store, herdr, cfg, queue } = deps;
  const audit = deps.audit ?? SILENT_AUDIT;
  const now = deps.now ?? Date.now;

  return async (command, opts = {}) => {
    const request = store.getRequest(command.requestId);
    if (!request) return fail("not_found", "no-such-request");
    if (request.status !== "pending") return fail("conflict", "not-pending");
    const bad = invalidAnswer(request, command);
    if (bad) return bad;
    const thread = store.getThread(request.threadId);
    if (!thread || thread.shelf === "archived") return fail("conflict", "thread-archived");
    const boundText = store.requestBoundText(request.id);
    if (!boundText) return fail("conflict", "unbound");
    const optionIndex = command.optionIndex!;
    const keys = request.options[optionIndex]!.keys;
    const paneId = thread.paneId;

    try {
      return await queue.run(paneKey(paneId), async (): Promise<RespondResult> => {
        // The ingestor may have expired it while this waited for the pane.
        const current = store.getRequest(request.id);
        if (!current || current.status !== "pending") return fail("conflict", "not-pending");

        const binding = await checkPromptBinding(herdr, cfg, paneId, boundText, "visible");
        if (!binding.ok) {
          audit.record({ action: "keys", paneId, detail: { keys, sent: false, promptBinding: binding.audit } });
          if (binding.status !== 409) return fail("failed", binding.error);
          // The screen moved on: this request is stale. The ingestor opens a fresh one if a dialog is up.
          store.append(requestEvents({ ...current, status: "expired", updatedAt: now() }), {
            ...(opts.commandId !== undefined ? { commandId: opts.commandId } : {}),
          });
          return fail("prompt-changed", "prompt changed");
        }

        try {
          await sendKeysPaced(herdr, paneId, keys, deps.sleep);
        } catch (err) {
          const detail: AuditDetail = { keys, sent: false, promptBinding: binding.audit };
          audit.record({ action: "keys", paneId, detail });
          return fail("failed", failureText("key send", err));
        }
        audit.record({ action: "keys", paneId, detail: { keys, promptBinding: binding.audit } });

        const resolved: RuntimeRequest = { ...current, status: "resolved", optionIndex, updatedAt: now() };
        const { last } = store.append(requestEvents(resolved), {
          ...(opts.commandId !== undefined
            ? {
                commandId: opts.commandId,
                receipt: {
                  type: "runtime-request.respond",
                  result: opts.receiptResult !== undefined ? opts.receiptResult : { requestId: request.id, optionIndex },
                },
              }
            : {}),
        });
        deps.onResolved?.(resolved);
        return { ok: true, sequence: last, request: resolved };
      });
    } catch (err) {
      if (err instanceof PaneBusyError) return fail("busy", "pane busy");
      throw err;
    }
  };
}
