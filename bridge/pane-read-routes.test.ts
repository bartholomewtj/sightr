import { describe, expect, test } from "bun:test";

import type { Config } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { JournalAdapter } from "./journal/types.ts";
import type { TranscriptStore } from "./journal/store.ts";
import { paneHistory } from "./pane-read-routes.ts";
import type { StateEngine } from "./state-engine.ts";

// Spec 09: an open pane re-asks for its newest history page on every snapshot, so the route tags
// the page and answers an unchanged one with an empty 304.

const PANE = "w1:p1";

function route(entries: { uuid: string }[]) {
  const cfg = { transcript: true } as unknown as Config;
  const journals = { claude: { agent: "claude" } as unknown as JournalAdapter };
  const transcripts = {
    page: async () => ({ entries, hasMore: false }),
  } as unknown as TranscriptStore;
  const engine = {
    current: () => ({
      agents: [{ paneId: PANE, agent: "claude", agentSession: { kind: "id", value: "s1" } }],
      shellPanes: [],
    }),
  } as unknown as StateEngine;
  const url = new URL(`http://x/api/pane/${PANE}/history?limit=160`);
  return (headers: Record<string, string> = {}) =>
    paneHistory(cfg, journals, transcripts, engine, {} as HerdrClient, PANE, url, new Request(url, { headers }));
}

describe("paneHistory ETag", () => {
  test("tags the page, and answers a matching If-None-Match with an empty 304", async () => {
    const get = route([{ uuid: "e1" }, { uuid: "e2" }]);
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(((await first.json()) as { entries: unknown[] }).entries).toHaveLength(2);

    const again = await get({ "if-none-match": etag! });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  test("a changed page gets a new tag and a full body", async () => {
    const before = (await route([{ uuid: "e1" }])()).headers.get("etag")!;
    const after = await route([{ uuid: "e1" }, { uuid: "e2" }])({ "if-none-match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });
});
