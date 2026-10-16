import type { RuntimeRequest } from "../../shared/v2/contracts.ts";
import {
  defaultSleep,
  multiSelectApplyRecipe,
  previewSelectRecipe,
  type RecipeIO,
  type RecipeResult,
} from "../../web/src/lib/dialog-recipes.ts";
import type { DialogKind, DialogModels } from "../../web/src/lib/harness/dialog-contract.ts";
import { dialogModel, dialogRegion } from "../../web/src/lib/harness/dialog-kit.ts";
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
//
// T17: two dialog shapes need more than one key list, and run a closed-loop recipe from
// web/src/lib/dialog-recipes.ts (the same code v1's buttons run) inside the same pane-queue turn:
//   - a preview select (`request.preview`): digit, re-read until the pointer is on that option,
//     then Enter;
//   - a checkbox step (`request.multiSelect`, answered with `optionIndices`): toggle each box whose
//     state differs from the wanted set, verifying each flip, then the harness's submit walk.
// Each re-read parses the screen through the thread's adapter (dialog-kit `dialogModel`). A read that
// shows anything else stops the recipe before its next key, and the request expires as stale.

/** Rows of the viewport a dialog read takes (the request ingest reads the same). */
export const DIALOG_READ_LINES = 60;

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

/** Why `request` cannot take this answer, or null when it can. */
function invalidAnswer(request: RuntimeRequest, command: RespondCommand): RespondResult | null {
  if (request.via === "whistlr") return fail("invalid", "whistlr-card");
  const boxes = request.multiSelect?.checked.length ?? 0;
  if (command.optionIndices !== undefined) {
    if (!request.multiSelect) return fail("invalid", "not-multi-select");
    if (command.optionIndex !== undefined) return fail("invalid", "both-answers");
    const wanted = command.optionIndices;
    if (
      !Array.isArray(wanted) ||
      wanted.some((i) => typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= boxes) ||
      new Set(wanted).size !== wanted.length
    ) {
      return fail("invalid", "bad-option");
    }
    return null;
  }
  if (request.options.length === 0) return fail("invalid", request.kind === "password" ? "password" : "no-options");
  const i = command.optionIndex;
  if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= request.options.length) {
    return fail("invalid", "bad-option");
  }
  // A box is toggled, not answered: the whole wanted set comes as `optionIndices`.
  if (i < boxes) return fail("invalid", "use-option-indices");
  if (request.options[i]!.keys.length === 0) return fail("invalid", "no-keys");
  return null;
}

/** Which recipe answers `request` with `command`, or null for T04's one key list. */
function recipeKind(request: RuntimeRequest, command: RespondCommand): "multi-select" | "preview-select" | null {
  if (command.optionIndices !== undefined) return "multi-select";
  if (request.preview) return "preview-select";
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
    const optionIndex = command.optionIndex;
    const optionIndices = command.optionIndices;
    const recipe = recipeKind(request, command);
    const keys = optionIndex !== undefined ? request.options[optionIndex]!.keys : [];
    const paneId = thread.paneId;
    const agent = thread.harness;
    const sleep = deps.sleep ?? defaultSleep;

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

        const expire = (): RespondResult => {
          store.append(requestEvents({ ...current, status: "expired", updatedAt: now() }), {
            ...(opts.commandId !== undefined ? { commandId: opts.commandId } : {}),
          });
          return fail("prompt-changed", "prompt changed");
        };

        if (recipe !== null) {
          // T17: the closed-loop recipes. Every key follows a fresh read parsed through the
          // thread's adapter; the keys that went out are audited whatever the outcome.
          const sent: string[] = [];
          const io = <K extends DialogKind>(kind: K): RecipeIO<DialogModels[K]> => ({
            read: async () => dialogModel(agent, (await herdr.readPane(paneId, "visible", DIALOG_READ_LINES, "ansi")).text, kind),
            send: async (toSend, region): Promise<RecipeResult> => {
              if (region !== undefined) {
                const bound = await checkPromptBinding(herdr, cfg, paneId, region, "visible");
                if (!bound.ok) return bound.status === 409 ? { status: "changed" } : { status: "error", error: bound.error };
              }
              try {
                await sendKeysPaced(herdr, paneId, toSend, deps.sleep);
              } catch (err) {
                return { status: "error", error: failureText("key send", err) };
              }
              sent.push(...toSend);
              return { status: "sent" };
            },
            sleep,
          });
          let outcome: RecipeResult;
          try {
            // The screen the binding just passed must still parse to this request's dialog.
            const kindIO = io(recipe);
            const tapped = await kindIO.read();
            if (!tapped || dialogRegion(recipe, tapped) !== boundText) {
              outcome = { status: "changed" };
            } else if (recipe === "multi-select") {
              const multi = tapped as DialogModels["multi-select"];
              const wanted = new Set(optionIndices);
              const boxes = multi.phase === "checkbox" ? multi.options.length : 0;
              outcome = await multiSelectApplyRecipe(
                kindIO as RecipeIO<DialogModels["multi-select"]>,
                multi,
                Array.from({ length: boxes }, (_, i) => wanted.has(i)),
                undefined,
              );
            } else {
              const preview = tapped as DialogModels["preview-select"];
              const option = preview.options[optionIndex!];
              outcome = option
                ? await previewSelectRecipe(kindIO as RecipeIO<DialogModels["preview-select"]>, preview, option.n, undefined)
                : { status: "changed" };
            }
          } catch (err) {
            outcome = { status: "error", error: failureText("herdr read", err) };
          }
          audit.record({
            action: "keys",
            paneId,
            detail: { keys: sent, recipe, ...(outcome.status === "sent" ? {} : { sent: false }), promptBinding: binding.audit },
          });
          if (outcome.status === "changed") return expire();
          if (outcome.status === "error") return fail("failed", outcome.error);
        } else {
          try {
            await sendKeysPaced(herdr, paneId, keys, deps.sleep);
          } catch (err) {
            const detail: AuditDetail = { keys, sent: false, promptBinding: binding.audit };
            audit.record({ action: "keys", paneId, detail });
            return fail("failed", failureText("key send", err));
          }
          audit.record({ action: "keys", paneId, detail: { keys, promptBinding: binding.audit } });
        }

        const answer = optionIndices !== undefined ? { optionIndices: [...optionIndices].sort((a, b) => a - b) } : { optionIndex: optionIndex! };
        const resolved: RuntimeRequest = { ...current, status: "resolved", ...answer, updatedAt: now() };
        const { last } = store.append(requestEvents(resolved), {
          ...(opts.commandId !== undefined
            ? {
                commandId: opts.commandId,
                receipt: {
                  type: "runtime-request.respond",
                  result: opts.receiptResult !== undefined ? opts.receiptResult : { requestId: request.id, ...answer },
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
