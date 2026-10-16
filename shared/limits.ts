/** Limits and protocol header names shared by the bridge and browser. */

/** The non-blank tail window accepted by prompt binding across all committed fixture regions. */
export const PROMPT_TAIL_LINES = 6;
/** Maximum expected prompt/reply text accepted by the write endpoint. */
export const MAX_REPLY_BYTES = 8192;
/** Marks a read as originating from Sightr's own page. */
export const SEEN_HEADER = "x-sightr-seen";
/**
 * The longest the bridge's snapshot stream stays silent: it writes a keep-alive and a ping after this
 * long without a snapshot. The phone treats a stream quiet for well past it as dead.
 */
export const SSE_KEEPALIVE_MS = 15_000;
/** Identifies the web bundle currently served by the bridge. */
export const BUILD_HEADER = "x-sightr-build";
/**
 * Sent by v1 (served at `/v1/` since the T15 cutover) on its API calls, so the bridge answers its
 * {@link BUILD_HEADER} with v1's build id. Requests without it get web2's id. Removed with v1.
 */
export const UI_HEADER = "x-sightr-ui";
