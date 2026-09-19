import { SILENT_AUDIT, type AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "./pane-queue.ts";
import { json, requireJsonBody, text } from "./responses.ts";
import type { ActionResponse, DecisionReplyRequest } from "../shared/wire.ts";
import { parseDecisionMarker, parseDecisionMarkerLine } from "./decision-marker.ts";
import { buildDecisionPayload } from "./decision-payload.ts";
import { submitDecisionReply, type SpawnRunner } from "./decision-reply.ts";

export async function decisionReplyPane(
  _herdr: HerdrClient,
  _cfg: Config,
  paneId: string,
  req: Request,
  queue: PaneQueue,
  audit: AuditLog = SILENT_AUDIT,
  runner?: SpawnRunner,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;

  let body: DecisionReplyRequest;
  try {
    body = (await req.json()) as DecisionReplyRequest;
  } catch {
    return text("bad body", 400);
  }

  if (!body.option || typeof body.option.label !== "string") {
    return text("bad option", 400);
  }

  const ae = req.headers.get("accept-encoding");
  const key = paneKey(paneId);

  let queued: { ok: true } | { ok: false; error: string };
  try {
    queued = await queue.run(key, async () => {
      let thread: string | undefined;
      let run: string | undefined;

      if (body.decision) {
        const line = `whistlr.decision thread=${body.decision.thread} run=${body.decision.run}`;
        const parsed = parseDecisionMarkerLine(line);
        if (parsed.kind === "refused") {
          return { ok: false, error: parsed.reason };
        }
        if (parsed.kind === "found") {
          thread = parsed.thread;
          run = parsed.run;
        }
      }

      if (!thread) {
        const textToScan = body.cardText ?? body.text ?? body.signature ?? body.question ?? "";
        const parsed = parseDecisionMarker(textToScan);
        if (parsed.kind === "refused") {
          return { ok: false, error: parsed.reason };
        }
        if (parsed.kind === "found") {
          thread = parsed.thread;
          run = parsed.run;
        }
      }

      if (!thread || !run) {
        return { ok: false, error: "no decision marker found" };
      }

      const payload = buildDecisionPayload(body.option, { notes: body.notes });

      return submitDecisionReply({
        thread,
        payload,
        runner,
      });
    });
  } catch (err) {
    if (err instanceof PaneBusyError) {
      return json({ ok: false, error: "pane busy" } satisfies ActionResponse, ae);
    }
    throw err;
  }

  if (queued.ok) {
    audit.record({
      action: "decision-reply",
      paneId,
      detail: {
        option: body.option.label,
        ok: true,
      },
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  }

  audit.record({
    action: "decision-reply",
    paneId,
    detail: {
      option: body.option.label,
      ok: false,
      error: queued.error,
    },
  });
  return json(
    { ok: false, error: queued.error } satisfies ActionResponse,
    ae,
  );
}
