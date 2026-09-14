import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TranscriptView } from "./transcript-view";
import type { TranscriptEntry } from "@/lib/types";

// TranscriptView renders the agent's own conversation log — the only history a Claude pane can have
// (its terminal runs on the alternate screen, which keeps no scrollback). The load-bearing
// behaviours: tool output stays collapsed so prose isn't buried, every string renders as TEXT (the
// same XSS boundary as the mirror), and a compaction summary is visibly not a human turn.

const stamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const turn = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: "u1",
  ts: "2026-07-25T06:22:21.253Z",
  role: "user",
  parts: [{ kind: "text", text: "hello" }],
  ...over,
});

describe("TranscriptView", () => {
  it("renders a human turn as a bubble and an assistant turn as plain text", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "what changed?" }] }),
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [{ kind: "text", text: "One commit." }],
          }),
        ]}
      />,
    );
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
    expect(screen.getByText("what changed?")).toBeInTheDocument();
    expect(screen.getByText("One commit.")).toBeInTheDocument();

    const userRow = document.querySelector('[data-turn="u1"]') as HTMLElement;
    const justifyEnd = userRow.querySelector<HTMLElement>(".justify-end");
    expect(justifyEnd).not.toBeNull();
    const bubble = userRow.querySelector<HTMLElement>(".bg-you");
    expect(bubble).not.toBeNull();
    expect(justifyEnd).toContainElement(bubble);

    const assistantRow = document.querySelector('[data-turn="a1"]') as HTMLElement;
    expect(assistantRow.querySelector(".bg-you")).toBeNull();
    expect(assistantRow.querySelector('[class*="border"]')).toBeNull();
    expect(assistantRow.querySelector('[class*="rounded-lg"]')).toBeNull();
  });

  it("shows a tool call's summary but keeps its output collapsed until tapped", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "git log --oneline",
                result: { text: "abc1234 the commit body" },
              },
            ],
          }),
        ]}
      />,
    );

    const foldBtn = screen.getByRole("button", { name: /Ran 1 command/ });
    expect(foldBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("git log --oneline")).not.toBeInTheDocument();
    expect(screen.queryByText(/abc1234 the commit body/)).not.toBeInTheDocument();

    await userEvent.click(foldBtn);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("git log --oneline")).toBeInTheDocument();
    // Collapsed by default — a real thread is mostly tool traffic, and expanding it all buries the prose.
    expect(screen.queryByText(/abc1234 the commit body/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/abc1234 the commit body/)).toBeInTheDocument();
  });

  it("keeps unified diff tool output on one row and pans it horizontally", async () => {
    render(
      <TranscriptView
        entries={[turn({ role: "assistant", parts: [{ kind: "tool", name: "Bash", summary: "git diff", result: { text: "-old column     value\n+new column     value" } }] })]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    const pre = screen.getByText(/-old column/).closest("pre");
    expect(pre).toHaveClass("whitespace-pre", "overflow-x-auto");
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
  });

  it("a tool call with no result isn't expandable (nothing to reveal) and displays running marker", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [{ kind: "tool", name: "Read", summary: "/a.ts" }],
          }),
        ]}
      />,
    );
    const foldBtn = screen.getByRole("button", { name: /Read 1 file/ });
    expect(foldBtn).not.toBeDisabled();
    expect(screen.getByText("running")).toBeInTheDocument();

    await userEvent.click(foldBtn);
    expect(screen.getAllByText("running")).toHaveLength(2);
    const buttons = screen.getAllByRole("button");
    const toolBtn = buttons.find((b) => b !== foldBtn);
    expect(toolBtn).toBeDisabled();
  });

  it("flags truncated output rather than silently dropping the tail", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Read",
                summary: "/big",
                result: { text: "start of output", truncated: true },
              },
            ],
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Read 1 file/ }));
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/output truncated/)).toBeInTheDocument();
  });

  it("marks a compaction summary as its own thing, not as something a human said", () => {
    const { container } = render(
      <TranscriptView
        entries={[turn({ role: "summary", parts: [{ kind: "text", text: "…prior context…" }] })]}
      />,
    );
    expect(screen.getByText(/Context compacted/)).toBeInTheDocument();
    expect(container.querySelector(".bg-you")).toBeNull();
    expect(container.querySelector(".justify-end")).toBeNull();
  });

  // Markdown introduced ONE new way for log content to reach the browser: an <a href>. A hostile
  // scheme must never survive as a real link — the parser refuses it and the text stays literal.
  it("never turns an unsafe link target into an anchor", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "[tap me](javascript:alert(1))" }] }),
        ]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/tap me/)).toBeInTheDocument();
  });

  it("a safe link renders as an anchor that can't reach back into the app", () => {
    const { container } = render(
      <TranscriptView
        entries={[turn({ parts: [{ kind: "text", text: "[docs](https://example.com)" }] })]}
      />,
    );
    const a = container.querySelector("a");
    expect(a).toHaveAttribute("href", "https://example.com");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("renders log text as TEXT, never as markup (the XSS boundary)", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <TranscriptView entries={[turn({ parts: [{ kind: "text", text: hostile }] })]} />,
    );
    // The characters survive verbatim…
    expect(screen.getByText(hostile)).toBeInTheDocument();
    // …and no element was ever constructed from them.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("renders prose as formatted Markdown", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({ parts: [{ kind: "text", text: "## Heading\n\n**bold** and `code`" }] }),
        ]}
      />,
    );
    // The syntax is consumed into structure rather than shown literally…
    expect(screen.queryByText(/## Heading/)).not.toBeInTheDocument();
    expect(screen.getByText("Heading")).toBeInTheDocument();
    // …and the emphasis/code become real elements.
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("tool output is NOT markdown-parsed — it's command output, kept verbatim", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [
              {
                kind: "tool",
                name: "Bash",
                summary: "cat notes.md",
                result: { text: "## literal heading\n**literal stars**" },
              },
            ],
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/## literal heading/)).toBeInTheDocument();
  });

  it("groups turns under a day divider, once per day", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "a", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "b", ts: "2026-07-25T07:00:00.000Z" }),
          turn({ uuid: "c", ts: "2026-07-26T08:00:00.000Z" }),
        ]}
      />,
    );
    const day25 = new Date("2026-07-25T06:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const day26 = new Date("2026-07-26T08:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    expect(screen.getAllByText(day25)).toHaveLength(1);
    expect(screen.getAllByText(day26)).toHaveLength(1);
  });

  it("survives a turn with no timestamp (no divider, no crash)", () => {
    render(<TranscriptView entries={[turn({ ts: "" })]} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("renders a user turn as a right-aligned bubble with bg-you styling", () => {
    render(
      <TranscriptView
        entries={[turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "hi" }] })]}
      />,
    );
    const row = document.querySelector('[data-turn="u1"]') as HTMLElement;
    const wrapper = row.querySelector(".justify-end") as HTMLElement;
    expect(wrapper).not.toBeNull();
    const bubble = wrapper.querySelector(".bg-you") as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveClass("bg-you", "text-you-foreground", "rounded-2xl", "max-w-[85%]");
  });

  it("renders an assistant turn as plain text with no bordered box and no bg-you", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", role: "user" }),
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "hello back" }] }),
        ]}
      />,
    );
    const row = document.querySelector('[data-turn="a1"]') as HTMLElement;
    expect(row.querySelector(".bg-you")).toBeNull();
    expect(row.querySelector('[class*="border"]')).toBeNull();
    expect(row.querySelector('[class*="rounded-lg"]')).toBeNull();
    expect(screen.getByText("hello back")).toBeInTheDocument();
  });

  it("sets hover title to local date and time on speech turns, but not summary or timestamp-less turns", () => {
    const ISO = "2026-07-25T06:22:21.253Z";
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "u1", role: "user", ts: ISO }),
          turn({ uuid: "a1", role: "assistant", ts: ISO }),
          turn({ uuid: "s1", role: "summary", ts: ISO }),
          turn({ uuid: "u2", role: "user", ts: "" }),
        ]}
      />,
    );
    const u1 = document.querySelector('[data-turn="u1"]') as HTMLElement;
    const a1 = document.querySelector('[data-turn="a1"]') as HTMLElement;
    const s1 = document.querySelector('[data-turn="s1"]') as HTMLElement;
    const u2 = document.querySelector('[data-turn="u2"]') as HTMLElement;

    expect(u1).toHaveAttribute("title", stamp(ISO));
    expect(a1).toHaveAttribute("title", stamp(ISO));
    expect(s1).not.toHaveAttribute("title");
    expect(u2).not.toHaveAttribute("title");
  });

  it("does not render bare clock text inside a speech turn", () => {
    const ISO = "2026-07-25T06:22:21.253Z";
    render(
      <TranscriptView
        entries={[turn({ uuid: "u1", role: "user", ts: ISO, parts: [{ kind: "text", text: "hello" }] })]}
      />,
    );
    const clock = new Date(ISO).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.queryByText(clock)).not.toBeInTheDocument();
  });

  it("a long press on a speech turn shows its time, and the next press anywhere hides it", () => {
    vi.useFakeTimers();
    try {
      const ISO = "2026-07-25T06:22:21.253Z";
      render(<TranscriptView entries={[turn({ uuid: "u1", ts: ISO })]} />);
      const row = document.querySelector('[data-turn="u1"]') as HTMLElement;
      fireEvent.pointerDown(row);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByText(stamp(ISO))).toBeInTheDocument();

      fireEvent.pointerDown(document.body);
      expect(screen.queryByText(stamp(ISO))).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a short tap does not show the long-press time chip", () => {
    vi.useFakeTimers();
    try {
      const ISO = "2026-07-25T06:22:21.253Z";
      render(<TranscriptView entries={[turn({ uuid: "u1", ts: ISO })]} />);
      const row = document.querySelector('[data-turn="u1"]') as HTMLElement;
      fireEvent.pointerDown(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      fireEvent.pointerUp(row);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByText(stamp(ISO))).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TranscriptView — no role labels", () => {
  it("renders consecutive assistant turns with no role labels", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "one" }] }),
          turn({ uuid: "a2", role: "assistant", parts: [{ kind: "text", text: "two" }] }),
          turn({ uuid: "a3", role: "assistant", parts: [{ kind: "text", text: "three" }] }),
        ]}
      />,
    );
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
    // Every turn's content still renders — only the repeated header is suppressed.
    for (const t of ["one", "two", "three"]) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it("renders alternating turns without role labels and one user bubble wrapper", () => {
    const { container } = render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", parts: [{ kind: "text", text: "one" }] }),
          turn({ uuid: "u1", role: "user", parts: [{ kind: "text", text: "ask" }] }),
          turn({ uuid: "a2", role: "assistant", parts: [{ kind: "text", text: "two" }] }),
        ]}
      />,
    );
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    for (const t of ["one", "ask", "two"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(container.querySelectorAll(".justify-end")).toHaveLength(1);
  });

  it("a day divider renders even for consecutive assistant turns, with no role label", () => {
    render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ uuid: "a1", role: "assistant", ts: "2026-07-25T06:00:00.000Z" }),
          turn({ uuid: "a2", role: "assistant", ts: "2026-07-26T06:00:00.000Z" }),
        ]}
      />,
    );
    expect(screen.queryByText("claude")).not.toBeInTheDocument();
    const day25 = new Date("2026-07-25T06:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    const day26 = new Date("2026-07-26T08:00:00.000Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    expect(screen.getAllByText(day25)).toHaveLength(1);
    expect(screen.getAllByText(day26)).toHaveLength(1);
  });
});

// Machine-injected content (a background task finishing, a local command's output) is real and
// belongs on screen, but it is NOT speech — it must never be attributed to the user or the agent.
describe("TranscriptView — system notes", () => {
  it("renders a note set apart, attributed to neither party", () => {
    const { container } = render(
      <TranscriptView
        agent="claude"
        entries={[
          turn({ role: "note", parts: [{ kind: "text", text: 'Agent "issue 8 fixes" finished' }] }),
        ]}
      />,
    );
    expect(screen.getByText(/System/)).toBeInTheDocument();
    expect(screen.getByText(/Agent "issue 8 fixes" finished/)).toBeInTheDocument();
    expect(container.querySelector(".bg-you")).toBeNull();
    expect(container.querySelector(".justify-end")).toBeNull();
  });

  it("keeps a compaction summary distinct from an ordinary note", () => {
    render(
      <TranscriptView
        entries={[
          turn({ uuid: "s", role: "summary", parts: [{ kind: "text", text: "…prior…" }] }),
          turn({ uuid: "n", role: "note", parts: [{ kind: "text", text: "task done" }] }),
        ]}
      />,
    );
    expect(screen.getByText(/Context compacted/)).toBeInTheDocument();
    expect(screen.getByText(/System/)).toBeInTheDocument();
  });
});

describe("TranscriptView — thinking", () => {
  it("'Thought for 12s' collapsed then expanded on click", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            ts: "2026-07-25T10:00:00.000Z",
            parts: [{ kind: "thinking", text: "Analyzing the request..." }],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            ts: "2026-07-25T10:00:12.000Z",
            parts: [{ kind: "text", text: "Here is the answer." }],
          }),
        ]}
      />,
    );
    const thinkingBtn = screen.getByRole("button", { name: /Thought for 12s/ });
    expect(thinkingBtn).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Analyzing the request\.\.\./)).not.toBeInTheDocument();

    await userEvent.click(thinkingBtn);
    expect(thinkingBtn).toHaveAttribute("aria-expanded", "true");
    const thinkingText = screen.getByText(/Analyzing the request\.\.\./);
    expect(thinkingText).toBeInTheDocument();
    expect(thinkingText.closest("div")).toHaveClass("italic", "text-muted-foreground");
  });

  it("renders 'Thinking' when duration is null on a thinking part in the last entry", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            ts: "2026-07-25T10:00:00.000Z",
            parts: [{ kind: "thinking", text: "Still pondering..." }],
          }),
        ]}
      />,
    );
    const thinkingBtn = screen.getByRole("button", { name: /Thinking/ });
    expect(thinkingBtn).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Still pondering\.\.\./)).toBeInTheDocument();
  });

  it("hides thinking parts when showThinking is false", () => {
    render(
      <TranscriptView
        showThinking={false}
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            ts: "2026-07-25T10:00:00.000Z",
            parts: [{ kind: "thinking", text: "Analyzing the request..." }],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            ts: "2026-07-25T10:00:12.000Z",
            parts: [{ kind: "text", text: "Here is the answer." }],
          }),
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /Thought for 12s/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Analyzing the request/)).not.toBeInTheDocument();
    expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
  });

  it("live thinking shows only the last lines", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `step ${i + 1}`).join("\n");
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            ts: "2026-07-25T10:00:00.000Z",
            parts: [{ kind: "thinking", text: lines }],
          }),
        ]}
      />,
    );
    expect(screen.queryByText(/step 1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/step 2/)).not.toBeInTheDocument();
    expect(screen.getByText(/step 3/)).toBeInTheDocument();
    expect(screen.getByText(/step 8/)).toBeInTheDocument();
  });

  it("renders 'Thought for 1m 05s' when 65 s apart", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            ts: "2026-07-25T10:00:00.000Z",
            parts: [{ kind: "thinking", text: "Deep thought" }],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            ts: "2026-07-25T10:01:05.000Z",
            parts: [{ kind: "text", text: "Done" }],
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Thought for 1m 05s/ })).toBeInTheDocument();
  });
});

// Consecutive tool-only assistant turns collapse across turns into one closed row (Claude Code
// writes one tool per entry, so a round of six is six entries). Output stays behind the inner tap,
// same as a singleton.
const tool = (
  name: string,
  summary: string,
  result?: { text: string; isError?: boolean },
): Extract<TranscriptEntry["parts"][number], { kind: "tool" }> => ({
  kind: "tool",
  name,
  summary,
  ...(result ? { result } : {}),
});

describe("TranscriptView — tool folds", () => {
  it("folds six tool-only entries into one closed row with the count label", () => {
    render(
      <TranscriptView
        entries={Array.from({ length: 6 }, (_, i) =>
          turn({
            uuid: `a${i}`,
            role: "assistant",
            parts: [tool("Bash", `git log -${i}`, { text: `commit ${i}` })],
          }),
        )}
      />,
    );
    expect(screen.getByRole("button", { name: /Ran 6 commands/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    for (let i = 0; i < 6; i++) {
      expect(screen.queryByText(`git log -${i}`)).not.toBeInTheDocument();
      expect(screen.queryByText(`commit ${i}`)).not.toBeInTheDocument();
    }
  });

  it("opens to show each tool, with output still collapsed", async () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "file a" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [tool("Grep", "TODO", { text: "line 4" })],
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Read 1 file, searched 1 file/ }));
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Grep")).toBeInTheDocument();
    expect(screen.getByText("TODO")).toBeInTheDocument();
    expect(screen.queryByText("file a")).not.toBeInTheDocument();
    expect(screen.queryByText("line 4")).not.toBeInTheDocument();
  });

  it("folds a single tool into a 1-tool fold row", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            role: "assistant",
            parts: [tool("Bash", "git log --oneline", { text: "abc" })],
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Ran 1 command/ })).toBeInTheDocument();
    expect(screen.queryByText("git log --oneline")).not.toBeInTheDocument();
  });

  it("merges tools across consecutive tool-only turns", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "a" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [tool("Grep", "TODO", { text: "b" })],
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Read 1 file, searched 1 file/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Read")).not.toBeInTheDocument();
    expect(screen.queryByText("Grep")).not.toBeInTheDocument();
  });

  it("folds Grok-style mixed prose+tools on one entry", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [
              { kind: "text", text: "I'll look at those files." },
              tool("read_file", "a.ts", { text: "a" }),
              tool("read_file", "b.ts", { text: "b" }),
              tool("run_terminal_command", "git status", { text: "ok" }),
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText("I'll look at those files.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Read 2 files, ran 1 command/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("read_file")).not.toBeInTheDocument();
    expect(screen.queryByText("run_terminal_command")).not.toBeInTheDocument();
    expect(screen.queryByText("a.ts")).not.toBeInTheDocument();
  });

  it("splits a tool run when prose sits between tools", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "a" }), tool("Grep", "TODO", { text: "b" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [{ kind: "text", text: "found it" }],
          }),
          turn({
            uuid: "a3",
            role: "assistant",
            parts: [tool("Edit", "/a.ts", { text: "c" }), tool("Bash", "git diff", { text: "d" })],
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Read 1 file, searched 1 file/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("found it")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edited 1 file, ran 1 command/ }),
    ).toBeInTheDocument();
  });

  it("opens a fold when find hits a name or summary inside it", () => {
    render(
      <TranscriptView
        query="TODO"
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "file a" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [tool("Grep", "TODO", { text: "line 4" })],
          }),
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Read 1 file, searched 1 file/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("TODO")).toBeInTheDocument();
    expect(screen.queryByText("line 4")).not.toBeInTheDocument();
  });

  it("flags an error on the fold header when any tool failed", () => {
    const { container } = render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "ok" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [tool("Bash", "false", { text: "exit 1", isError: true })],
          }),
        ]}
      />,
    );
    expect(container.querySelector(".text-destructive")).not.toBeNull();
  });

  it("shows running on the fold header when any tool has no result", () => {
    render(
      <TranscriptView
        entries={[
          turn({
            uuid: "a1",
            role: "assistant",
            parts: [tool("Read", "/a.ts", { text: "ok" })],
          }),
          turn({
            uuid: "a2",
            role: "assistant",
            parts: [tool("Grep", "TODO")],
          }),
        ]}
      />,
    );
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Read 1 file, searched 1 file/ }),
    ).not.toBeDisabled();
  });
});
