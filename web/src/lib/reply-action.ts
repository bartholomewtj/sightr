// The guarded free-text reply (`sendReplyOnBridge`, `sendGuardedReply`, `draftCarriesSend`).
// Split out of lib/actions.ts, which re-exports it (spec 12).
//
// The guard itself lives in lib/guarded-send.ts so the bridge can run it next to Herdr (spec 24):
// one request instead of six or more phone↔bridge round trips. This file is the browser's side: the
// request to the bridge, and the same guard run here for a bridge too old to have the route.

import { fetchPane, isApiErrorStatus, sendGuarded, sendReply } from "./api";
import { adapterFor } from "./harness";
import { POLL_ATTEMPTS, POLL_DELAY_MS, defaultSleep, type Sleep } from "./harness/guard";
import { runGuardedSend, type ComposerPrepResult, type ComposerSeen, type ReplyOutcome } from "./guarded-send";

export { draftCarriesSend } from "./guarded-send";
export type { ReplyOutcome } from "./guarded-send";

interface GuardedReplyArgs {
  paneId: string;
  text: string;
  /** The pane's agent — picks the adapter whose `extractInputDraft` can read the input box. */
  agent: string | undefined | null;
  /** Lines to request per verification read (undefined = the bridge's default tail, which is where
   *  the input box always is). */
  requestedLines?: number;
  /** Test seam for the poll pacing. */
  sleep?: Sleep;
  /** See GuardedSendArgs.force (lib/guarded-send.ts). */
  force?: boolean;
  /**
   * The browser's pre-clear sweep, for the fallback path only (see GuardedSendArgs.onComposerSeen).
   * The bridge sizes and sends its own sweep from its own live read, so it is not sent there.
   */
  onComposerSeen?: (seen: ComposerSeen) => Promise<ComposerPrepResult>;
}

/**
 * Send through the bridge's guard (`POST /api/pane/:id/send`). A bridge without the route (404 or
 * 405: an older build behind a newer page) gets the same guard run from here.
 */
export async function sendReplyOnBridge(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  try {
    return await sendGuarded(args.paneId, { text: args.text, ...(args.force ? { force: true } : {}) });
  } catch (e) {
    if (isApiErrorStatus(e, 404) || isApiErrorStatus(e, 405)) return sendGuardedReply(args);
    // No answer: the bridge may have typed, or even submitted, before the link dropped. Say so.
    return { status: "error", error: `${message(e)} — check the pane before resending.` };
  }
}

/** The guard, run from the browser: every read and write is a request to the bridge. */
export function sendGuardedReply(args: GuardedReplyArgs): Promise<ReplyOutcome> {
  return runGuardedSend(
    adapterFor(args.agent ?? undefined),
    {
      read: async () => (await fetchPane(args.paneId, args.requestedLines)).text,
      type: (text, paste) => sendReply(args.paneId, text, false, undefined, undefined, paste),
      submit: (keys) => sendReply(args.paneId, "", true, undefined, keys),
      oneShot: (text) => sendReply(args.paneId, text, true),
      sleep: args.sleep ?? defaultSleep,
      pollAttempts: POLL_ATTEMPTS,
      pollDelayMs: POLL_DELAY_MS,
    },
    { text: args.text, force: args.force, onComposerSeen: args.onComposerSeen },
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
