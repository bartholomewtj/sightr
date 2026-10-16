import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type RuntimeRequest } from "@shared/v2/contracts";
import { __setComposerDeps } from "@/state/composer";
import { threadFromSnapshot } from "@/stream/apply";
import { useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatComposer } from "./ChatComposer";

// T19: a whistlr-marked draftr card goes through `whistlr reply` (the v1 decision-reply route), never
// keys and never `runtime-request.respond`.

let commands: Record<string, unknown>[] = [];
let replies: { paneId: string; body: Record<string, unknown> }[] = [];
let keys: unknown[] = [];
let decisionAnswer: () => Response = () => HttpResponse.json({ ok: true });

beforeEach(() => {
  commands = [];
  replies = [];
  keys = [];
  decisionAnswer = () => HttpResponse.json({ ok: true });
  setViewportWidth(800);
  let n = 0;
  __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      commands.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true, sequence: 200 });
    }),
    http.post("/api/pane/:paneId/decision-reply", async ({ request, params }) => {
      replies.push({ paneId: String(params.paneId), body: (await request.json()) as Record<string, unknown> });
      return decisionAnswer();
    }),
    http.post("/api/pane/:paneId/keys", async ({ request }) => {
      keys.push(await request.json());
      return HttpResponse.json({ ok: true });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

function card(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    id: "r1",
    threadId: "t1",
    kind: "question",
    prompt: "Ship slice 3 or hold?",
    options: [
      { label: "Ship it", keys: [] },
      { label: "Hold", keys: [] },
    ],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
    via: "whistlr",
    decision: { thread: "th-9", run: "run-4" },
    ...over,
  };
}

function show(requests: RuntimeRequest[]) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { status: "input", capabilities: { ...NO_CAPABILITIES, hasJournal: true } }),
        runs: [],
        items: [],
        requests,
        queue: [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
  return render(<ChatComposer threadId="t1" />);
}

function settleRequest(status: RuntimeRequest["status"]): void {
  act(() => {
    const current = useThreadStore.getState().current!;
    useThreadStore.setState({ current: { ...current, requests: { r1: { ...current.requests.r1!, status } } } });
  });
}

describe("whistlr decision cards", () => {
  it("a marked request posts decision-reply with the option and the decision, and never a v2 command or keys", async () => {
    show([card()]);
    expect(screen.getByText("Decision for the operator")).toBeInTheDocument();
    expect(screen.getByText("Ship slice 3 or hold?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toEqual({
      paneId: "p-t1",
      body: {
        decision: { thread: "th-9", run: "run-4" },
        option: { label: "Hold", keyLabel: "2" },
        question: "Ship slice 3 or hold?",
      },
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent with whistlr reply."));
    expect(commands).toHaveLength(0);
    expect(keys).toHaveLength(0);
  });

  it("the tapped option stays busy until the card leaves pending", async () => {
    show([card()]);
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }));
    await waitFor(() => expect(replies).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent with whistlr reply."));
    expect(screen.getByRole("button", { name: /Ship it/ })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Hold" })).toBeDisabled();
    // A second tap sends nothing more.
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    settleRequest("resolved");
    await waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument());
    expect(replies).toHaveLength(1);
  });

  it("a failed reply shows the bridge's error and keeps the card answerable", async () => {
    decisionAnswer = () => HttpResponse.json({ ok: false, error: "no decision marker found" });
    show([card()]);
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("whistlr reply failed: no decision marker found"));
    expect(screen.getByText("Decision for the operator")).toBeInTheDocument();
    const again = screen.getByRole("button", { name: "Ship it" });
    expect(again).toBeEnabled();
    fireEvent.click(again);
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(commands).toHaveLength(0);
  });

  it("an unmarked question keeps T12's path: runtime-request.respond, no decision-reply", async () => {
    show([card({ via: undefined, decision: undefined, options: [{ label: "Ship it", keys: ["1"] }, { label: "Hold", keys: ["2"] }] })]);
    expect(screen.queryByText("Decision for the operator")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Hold/ }));
    await waitFor(() => expect(commands.filter((c) => c.type === "runtime-request.respond")).toHaveLength(1));
    expect(commands[0]).toMatchObject({ requestId: "r1", optionIndex: 1 });
    expect(replies).toHaveLength(0);
  });
});
