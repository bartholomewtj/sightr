import { useEffect, useRef, useState } from "react";
import { Brain, ChevronRight, Info, TriangleAlert, Wrench } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { foldEntries, foldLabel, thinkingDuration, type FoldTool } from "@/lib/transcript-fold";
import { splitHighlight } from "@/lib/transcript-search";
import type { TranscriptEntry, TranscriptPart } from "@/lib/types";

/** Same surface find searches (`name` + `summary`). A hit here means the fold must start open so
 *  the highlight is actually on screen. */
function toolRunMatchesQuery(tools: FoldTool[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return false;
  return tools.some(
    (t) => t.name.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle),
  );
}

// Renders an agent transcript — the conversation history a Claude pane's terminal structurally
// cannot hold (it runs on the alternate screen, which keeps no scrollback ring; see
// bridge/transcript.ts). This is a DIFFERENT representation from the terminal mirror, deliberately:
// the mirror is a faithful 51-row snapshot of a TUI, while this is the thread itself — speech renders
// as a chat (user bubble right, agent plain text), the time is a hover title or long-press chip, and
// summaries and notes stay visibly set apart.
//
// XSS boundary, same rule as the mirror: every string from the log reaches the DOM as a React TEXT
// NODE, never as markup. Prose IS parsed as Markdown (lib/markdown.ts) — but that parser emits an
// AST which the renderer maps to React elements, so no HTML string is ever constructed. The fold
// row's label comes from foldLabel, which builds a plain string out of tool names and reaches the
// DOM as a text node like everything else — it is never markup. Do not "improve" this by swapping
// in a markdown→HTML library without re-deriving that boundary.

/** Full local date and time — the desktop hover title and the phone long-press chip. Empty for a
 *  turn with no usable timestamp, in which case neither appears. */
function fullTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A pointer held this long on a speech turn reveals its time chip. Long enough that a tap or a
 *  scroll start never triggers it. */
const LONG_PRESS_MS = 500;

/** Plain text with find hits marked — for strings that are NOT Markdown (shell commands, output). */
function Highlight({ text, query }: { text: string; query: string }) {
  if (query.trim() === "") return <>{text}</>;
  const pieces = splitHighlight(text, query);
  if (pieces.length === 1 && !pieces[0]!.hit) return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.hit ? (
          <mark key={i} className="rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40">
            {piece.text}
          </mark>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/**
 * A tool call: its one-line summary always, its output behind a tap. Collapsed by default because a
 * thread is mostly tool traffic (705 of 914 turns in a real session) and expanding it all would bury
 * the prose you opened the history to read.
 */
function ToolPart({ part, query }: { part: Extract<TranscriptPart, { kind: "tool" }>; query: string }) {
  const [open, setOpen] = useState(false);
  const result = part.result;
  const isError = result?.isError === true;

  return (
    <div className="rounded-md border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!result}
        aria-expanded={result ? open : undefined}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left disabled:opacity-100"
      >
        {isError ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs font-semibold">{part.name}</span>
        {part.summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {/* A shell command, NOT prose — markdown-parsing it would eat globs and backticks. */}
            <Highlight text={part.summary} query={query} />
          </span>
        )}
        {!result && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground animate-pulse">
            running
          </span>
        )}
        {result && (
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && result && (
        // Command output is column-aligned; pan it like Files Git and markdown tables rather than wrapping it.
        <pre className="overflow-x-auto border-t px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre">
          {result.text}
          {result.truncated && <span className="text-muted-foreground">{"\n… output truncated"}</span>}
        </pre>
      )}
    </div>
  );
}

/**
 * A run of consecutive tool-only assistant turns folded into one closed row.
 * Grok batches tool_calls onto the spoken row; foldEntries peels those tools into this run.
 * Output stays behind the inner tool tap.
 */
function ToolFold({ tools, query }: { tools: FoldTool[]; query: string }) {
  const match = toolRunMatchesQuery(tools, query);
  const [open, setOpen] = useState(match);
  useEffect(() => {
    if (match) setOpen(true);
  }, [match]);

  const isError = tools.some((t) => t.result?.isError === true);
  const running = tools.some((t) => !t.result);
  const label = foldLabel(tools);

  return (
    <div className="rounded-md border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      >
        {isError ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">
          {label}
        </span>
        {running && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground animate-pulse">
            running
          </span>
        )}
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-2 py-1.5">
          {tools.map((part, i) => (
            <ToolPart key={i} part={part} query={query} />
          ))}
        </div>
      )}
    </div>
  );
}

/** "12s" under a minute, "1m 05s" past it — zero-padded seconds so the width doesn't jump. */
function thoughtLabel(seconds: number | null): string {
  if (seconds === null) return "Thinking";
  if (seconds < 60) return `Thought for ${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `Thought for ${m}m ${String(s).padStart(2, "0")}s`;
}

/** Last N lines of a thinking block — live view shows the tail, not the whole scratchpad. */
function thinkingTail(text: string, lines = 6): string {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.length <= lines) return text;
  return parts.slice(-lines).join("\n");
}

function thinkingMatchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle !== "" && text.toLowerCase().includes(needle);
}

/** Thinking is not speech and is rarely re-read, so it collapses to how long it took. ChatGPT, Claude,
 *  and Grok all do the same: a duration header, a chevron, and the body behind a tap. Live (duration
 *  still null) stays open on the last few lines so a phone has something to watch; it folds when the
 *  next entry lands. The duration is the gap to the next entry (thinkingDuration). */
function ThinkingPart({
  part,
  seconds,
  query,
}: {
  part: Extract<TranscriptPart, { kind: "thinking" }>;
  seconds: number | null;
  query: string;
}) {
  const live = seconds === null;
  const match = thinkingMatchesQuery(part.text, query);
  const [open, setOpen] = useState(live || match);
  useEffect(() => {
    if (match) setOpen(true);
  }, [match]);
  useEffect(() => {
    if (!live && !match) setOpen(false);
  }, [live, match]);

  const body = live ? thinkingTail(part.text) : part.text;

  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground"
      >
        <Brain className="size-3.5 shrink-0" />
        <span className={`min-w-0 flex-1 ${live ? "animate-pulse" : ""}`}>{thoughtLabel(seconds)}</span>
        <ChevronRight
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && body !== "" && (
        <div className="mt-1 max-h-40 overflow-y-auto border-l-2 border-border pl-2.5 italic text-muted-foreground">
          <MarkdownText text={body} query={query} className="italic text-muted-foreground" />
          {part.truncated && <div className="text-xs text-muted-foreground">… truncated</div>}
        </div>
      )}
    </div>
  );
}

function Part({
  part,
  query,
  seconds,
}: {
  part: TranscriptPart;
  query: string;
  seconds: number | null;
}) {
  // Tool output is COMMAND output, not prose — it stays verbatim in a monospace block (see ToolPart).
  if (part.kind === "tool") return <ToolPart part={part} query={query} />;
  if (part.kind === "thinking") return <ThinkingPart part={part} seconds={seconds} query={query} />;
  // Prose is Markdown, so it renders formatted. MarkdownText emits React elements only — never
  // markup — so this keeps the same XSS boundary the raw text node had.
  return (
    <div>
      <MarkdownText text={part.text} query={query} />
      {part.truncated && <div className="text-xs text-muted-foreground">… truncated</div>}
    </div>
  );
}

function Parts({
  parts,
  query,
  seconds,
}: {
  parts: TranscriptPart[];
  query: string;
  seconds: number | null;
}) {
  return parts.map((part, i) => (
    <Part key={i} part={part} query={query} seconds={seconds} />
  ));
}

function Turn({
  entry,
  query,
  seconds,
}: {
  entry: TranscriptEntry;
  query: string;
  seconds: number | null;
}) {
  // Neither of these is speech, so both render dashed-and-muted — visibly set apart from the
  // conversation rather than attributed to the user or the agent.
  if (entry.role === "summary" || entry.role === "note") {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <Info className="size-3" />
          {entry.role === "summary" ? "Context compacted" : "System"}
        </div>
        <Parts parts={entry.parts} query={query} seconds={seconds} />
      </div>
    );
  }

  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        {/* Descendant overrides rather than edits to markdown-text.tsx: inside this fixed blue fill a
            `bg-muted` code chip and a `text-primary` link are theme-coloured and vanish in dark mode. */}
        <div className="max-w-[85%] space-y-1.5 rounded-2xl bg-you px-3 py-2 text-you-foreground [&_a]:text-inherit [&_code]:bg-black/10 [&_code]:text-inherit [&_pre]:border-black/10 [&_pre]:bg-black/10 [&_pre]:text-inherit">
          <Parts parts={entry.parts} query={query} seconds={seconds} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Parts parts={entry.parts} query={query} seconds={seconds} />
    </div>
  );
}

/** One entry's outer row: the find/jump target (`data-turn`), the focus ring, and — for speech only —
 *  the timestamp affordances. Desktop gets `title` on hover. A phone has no hover, so a ~500 ms
 *  press shows the same string as a chip; the next pointerdown anywhere dismisses it. */
function TurnRow({
  entry,
  focused,
  children,
}: {
  entry: TranscriptEntry;
  focused: boolean;
  children: React.ReactNode;
}) {
  const speech = entry.role === "user" || entry.role === "assistant";
  const stamp = fullTime(entry.ts);
  const pressable = speech && stamp !== "";
  const [chip, setChip] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!chip) return;
    // Capture phase, same rule as ui/popover.tsx: the chip is transient, so the next press anywhere
    // closes it — including the press that starts the next long-press.
    const onDown = () => setChip(false);
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [chip]);

  const press = pressable
    ? {
        onPointerDown: () => {
          cancel();
          timer.current = window.setTimeout(() => setChip(true), LONG_PRESS_MS);
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
        onPointerLeave: cancel,
      }
    : {};

  return (
    <div
      data-turn={entry.uuid}
      // select-none + -webkit-touch-callout:none for the same reason as pane-strip.tsx: iOS Safari
      // would otherwise answer the hold with its selection loupe / touch callout instead of our chip.
      className={`relative space-y-3 ${pressable ? "select-none [-webkit-touch-callout:none]" : ""} ${
        focused ? "rounded-lg ring-2 ring-primary/60 ring-offset-2 ring-offset-background" : ""
      }`}
      {...(pressable ? { title: stamp } : {})}
      {...press}
    >
      {children}
      {chip && (
        <span className="pointer-events-none absolute top-0 right-2 z-10 rounded-md bg-foreground px-1.5 py-0.5 text-[11px] text-background shadow">
          {stamp}
        </span>
      )}
    </div>
  );
}

function DayDivider({ day }: { day: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium text-muted-foreground">{day}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function TranscriptView({
  entries,
  query = "",
  focusedUuid,
  showThinking = true,
}: {
  entries: TranscriptEntry[];
  /** Accepted for callers that still pass it; turns no longer show a per-turn brand icon. */
  agent?: string;
  /** Active find query — highlighted throughout. */
  query?: string;
  /** The turn a find/jump landed on; ringed so you can see where you were sent. */
  focusedUuid?: string;
  /** When false, thinking parts are omitted (Display → Show thinking). */
  showThinking?: boolean;
}) {
  return (
    <div className="space-y-3">
      {foldEntries(entries).map((item) => {
        if (item.kind === "divider") return <DayDivider key={item.key} day={item.day} />;
        if (item.kind === "fold") return (
          <div
            key={item.key}
            data-turn={item.entries[0]!.uuid}
            className={`space-y-1.5 ${
              item.entries.some((e) => e.uuid === focusedUuid)
                ? "rounded-lg ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                : ""
            }`}
          >
            <ToolFold tools={item.tools} query={query} />
          </div>
        );
        const parts = showThinking
          ? item.entry.parts
          : item.entry.parts.filter((p) => p.kind !== "thinking");
        if (parts.length === 0) return null;
        const entry = parts === item.entry.parts ? item.entry : { ...item.entry, parts };
        return (
          <TurnRow key={item.key} entry={entry} focused={entry.uuid === focusedUuid}>
            <Turn entry={entry} query={query} seconds={thinkingDuration(entries, item.index)} />
          </TurnRow>
        );
      })}
    </div>
  );
}
