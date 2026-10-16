/**
 * The frames of the v2 API (docs/specs/t3/T05-v2-api.md) as web2 reads them.
 *
 * Every domain, event and turn-item type comes from `shared/v2/contracts.ts`; this file only names the
 * envelopes T05 wraps them in (stream snapshots, the command reply, the error body, a history page),
 * which `contracts.ts` does not list yet. When T05 adds them there, re-export them from here.
 */
import type {
  Project,
  QueuedMessage,
  Run,
  RuntimeRequest,
  RuntimeRequestSummary,
  Thread,
  TurnItem,
} from "@shared/v2/contracts";

export const V2_SHELL_PATH = "/api/v2/shell";
export const V2_COMMAND_PATH = "/api/v2/command";
export const v2ThreadPath = (threadId: string) => `/api/v2/thread/${encodeURIComponent(threadId)}`;
export const v2HistoryPath = (threadId: string) => `${v2ThreadPath(threadId)}/history`;

/** `event: snapshot` on the shell stream. */
export interface ShellSnapshot {
  sequence: number;
  projects: Project[];
  threads: Thread[];
  requests: RuntimeRequestSummary[];
}

/** `event: snapshot` on a thread stream (replay would have exceeded 128 events). */
export interface ThreadSnapshot {
  sequence: number;
  thread: Thread;
  runs: Run[];
  items: TurnItem[];
  requests: RuntimeRequest[];
  queue: QueuedMessage[];
  historyCursor: string | null;
}

/** `event: synchronized` and `event: ping`. */
export interface SequenceFrame {
  sequence: number;
}

/** `POST /api/v2/command` success. */
export interface CommandReply {
  ok: true;
  sequence: number;
}

/** Any `/api/v2/*` refusal. `have`/`need` come with `herdr-too-old`. */
export interface V2ErrorBody {
  ok: false;
  code: string;
  error?: string;
  have?: string;
  need?: string;
}

/** `GET /api/v2/thread/:id/history`. */
export interface HistoryPage {
  runs: { run: Run; items: TurnItem[] }[];
  loose: TurnItem[];
  nextCursor: string | null;
}

/** The codes that make v2 unusable on this host until something changes there (full-screen state). */
export const BLOCKING_CODES = ["herdr-too-old", "v2-disabled"] as const;
export type BlockingCode = (typeof BLOCKING_CODES)[number];

export function isBlockingCode(code: unknown): code is BlockingCode {
  return typeof code === "string" && (BLOCKING_CODES as readonly string[]).includes(code);
}

export function isV2ErrorBody(value: unknown): value is V2ErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string"
  );
}
