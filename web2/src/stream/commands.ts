/**
 * The command client: `POST /api/v2/command` (T05).
 *
 * `sendCommand(type, payload)` posts `{ commandId, type, ...payload }` and resolves to `{ sequence }`,
 * the intent committed on the bridge; it does not wait for the resulting event (the streams deliver
 * it). A network failure is retried once with the same `commandId`, so a request whose response was
 * lost is applied once (the bridge keeps a receipt per id).
 */
import type { CommandOf, CommandType } from "@shared/v2/contracts";
import { timedFetch } from "@v1/lib/conn-telemetry";

import { noteIfLocked, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";

import { clearBlocked, setBlocked } from "./stores";
import { isBlockingCode, isV2ErrorBody, V2_COMMAND_PATH, type CommandReply, type V2ErrorBody } from "./wire";

/** The fields a caller supplies; `commandId` and `type` are added here. */
export type CommandPayload<T extends CommandType> = Omit<CommandOf<T>, "commandId" | "type">;

export class V2CommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: V2ErrorBody | null;
  constructor(status: number, body: V2ErrorBody | null) {
    super(body?.error ?? body?.code ?? `command failed (${status})`);
    this.name = "V2CommandError";
    this.status = status;
    this.code = body?.code ?? `http-${status}`;
    this.body = body;
  }
}

export interface CommandDeps {
  fetch: typeof fetch;
  newId: () => string;
}

/** The real fetch and a random UUID. A caller that must know the `commandId` up front (an optimistic
 * change keyed by it, T10) spreads these and replaces `newId`. */
export const defaultCommandDeps = (): CommandDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  newId: () => crypto.randomUUID(),
});

const isAbort = (err: unknown) => (err as { name?: string } | null)?.name === "AbortError";

export async function sendCommand<T extends CommandType>(
  type: T,
  payload: CommandPayload<T>,
  deps: CommandDeps = defaultCommandDeps(),
): Promise<{ sequence: number }> {
  const body = JSON.stringify({ ...payload, commandId: deps.newId(), type });
  const post = () =>
    timedFetch("write", () =>
      deps.fetch(V2_COMMAND_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE },
        body,
      }),
    );

  let res: Response;
  try {
    res = await post();
  } catch (err) {
    if (isAbort(err)) throw err;
    res = await post(); // once, same commandId
  }

  if (res.ok) {
    clearBlocked();
    const reply = (await res.json()) as CommandReply;
    return { sequence: reply.sequence };
  }

  noteIfLocked(res);
  const parsed: unknown = await res.json().catch(() => null);
  const error = isV2ErrorBody(parsed) ? parsed : null;
  if (res.status === 503 && error && isBlockingCode(error.code)) {
    setBlocked({ code: error.code, error: error.error ?? "", have: error.have, need: error.need });
  }
  throw new V2CommandError(res.status, error);
}
