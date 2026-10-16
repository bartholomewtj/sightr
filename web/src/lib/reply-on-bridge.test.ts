import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { sendReplyOnBridge } from "./reply-action";

const SEND = /\/api\/pane\/[^/]+\/send$/;
const REPLY = /\/api\/pane\/[^/]+\/reply$/;
const RULE = "─".repeat(40);

describe("sendReplyOnBridge", () => {
  it("posts the text (and force) once and answers the bridge's outcome", async () => {
    const bodies: unknown[] = [];
    let replies = 0;
    server.use(
      http.post(SEND, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ status: "sent" });
      }),
      http.post(REPLY, () => { replies++; return HttpResponse.json({ ok: true }); }),
    );
    await expect(sendReplyOnBridge({ paneId: "w1:p1", text: "hello there", agent: "claude" })).resolves.toEqual({ status: "sent" });
    await expect(sendReplyOnBridge({ paneId: "w1:p1", text: "again", agent: "claude", force: true })).resolves.toEqual({ status: "sent" });
    expect(bodies).toEqual([{ text: "hello there" }, { text: "again", force: true }]);
    // The guard ran on the bridge: the browser typed nothing itself.
    expect(replies).toBe(0);
  });

  it("passes a refusal through as it is", async () => {
    server.use(http.post(SEND, () => HttpResponse.json({ status: "blocked", error: "no box" })));
    await expect(sendReplyOnBridge({ paneId: "w1:p1", text: "hi", agent: "claude" })).resolves.toEqual({ status: "blocked", error: "no box" });
  });

  it("falls back to the browser guard when the bridge has no route", async () => {
    let draft = "";
    const typed: unknown[] = [];
    server.use(
      http.post(SEND, () => new HttpResponse("not found", { status: 404 })),
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({ paneId: "w1:p1", text: `out\n${RULE}\n❯ ${draft}\n${RULE}`, truncated: false, revision: 0 }),
      ),
      http.post(REPLY, async ({ request }) => {
        const body = (await request.json()) as { text: string; submit: boolean };
        typed.push(body);
        if (!body.submit) draft += body.text;
        else draft = "";
        return HttpResponse.json({ ok: true });
      }),
    );
    const out = await sendReplyOnBridge({ paneId: "w1:p1", text: "fallback works", agent: "claude", sleep: async () => {} });
    expect(out).toEqual({ status: "sent" });
    expect(typed[0]).toEqual(expect.objectContaining({ text: "fallback works", submit: false }));
  });

  it("a send with no answer says to check the pane, and is not retried", async () => {
    let calls = 0;
    server.use(http.post(SEND, () => { calls++; return HttpResponse.error(); }));
    const out = await sendReplyOnBridge({ paneId: "w1:p1", text: "lost in transit", agent: "claude" });
    expect(out.status).toBe("error");
    expect(out.status === "error" && out.error).toMatch(/check the pane before resending/);
    expect(calls).toBe(1);
  });
});
