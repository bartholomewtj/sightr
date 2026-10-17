/**
 * What an opened tool row shows (T11). The job of T3 Code's `V2ItemInspector`
 * (apps/web/src/components/chat/V2ItemInspector.tsx @ e3b35d1b, pattern only): the call, then its
 * output, per item kind. Sightr's items carry their output inline (T03), so nothing is fetched; the
 * component is only mounted while its row is open, which is what keeps long outputs lazy.
 *
 * Text is rendered as text nodes only. Output is cut at {@link MAX_OUTPUT_LINES} lines with a note,
 * and an item the journal adapter cut (`truncated`) says so.
 *
 * Phone pass: paths, URLs and search hits wrap anywhere (a 360 px lane has no room for a long path);
 * a diff's lines carry add/remove colour; a long `system_notice` (T3's StructuredValue) opens to its
 * full text instead of staying a truncated label.
 *
 * Structured payloads (V2ItemInspector @ db5919d87, pattern): a file change shows T3's DiffStatLabel,
 * a Copy for the diff and, when it failed, the tool's own error above the diff it meant to make; a
 * `todo_list` opens to its checklist; a dynamic tool lists its capped arguments (`rawInput`, T3's
 * args list). Older stored items without these fields render as before.
 */
import type { TurnItem } from "@shared/v2/contracts";
import { CheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";

import { isSafeMarkdownHref } from "../ChatMarkdown";
import { DiffStatLabel } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";

export const MAX_OUTPUT_LINES = 200;

/** A notice longer than this is cut by its one-line row on a phone, so it gets a toggle. */
const NOTICE_LABEL_CHARS = 48;

function diffLineClassName(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-foreground/70";
  if (line.startsWith("+")) return "text-success";
  if (line.startsWith("-")) return "text-destructive";
  if (line.startsWith("@@")) return "text-info";
  return undefined;
}

const monoClassName = "font-mono text-(length:--text-2xs) leading-relaxed";

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * A call's arguments as `[key, value]` rows (T3's `toolCallLines` job): strings as they are, anything
 * else as JSON. Empty values are left out; a non-object has no rows.
 */
export function argEntries(rawInput: unknown): [string, string][] {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return [];
  return Object.entries(rawInput as Record<string, unknown>).flatMap(([key, value]): [string, string][] => {
    if (value === undefined || value === null || value === "") return [];
    const text = typeof value === "string" ? value : asText(value);
    return text === null || text.trim() === "" ? [] : [[key, text]];
  });
}

function TodoStepIcon({ status }: { status: Extract<TurnItem, { type: "todo_list" }>["steps"][number]["status"] }) {
  if (status === "completed") return <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />;
  if (status === "running") return <CircleDotIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-info motion-safe:animate-status-pulse" />;
  return <CircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

const TODO_STATUS_LABEL = { completed: "done", running: "in progress", pending: "to do" } as const;

/** The first {@link MAX_OUTPUT_LINES} lines, and how many were left out. */
export function capLines(text: string, max = MAX_OUTPUT_LINES): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** True when opening the row would show more than its label already says (else: no toggle). */
export function toolItemHasDetail(item: TurnItem, label: string): boolean {
  const filled = (value: string | undefined | null) => typeof value === "string" && value.trim().length > 0;
  switch (item.type) {
    case "command_execution":
      return filled(item.output) || (item.exitCode !== undefined && item.exitCode !== 0) || commandDisplayText(item.input) !== label.trim();
    case "dynamic_tool": {
      const input = asText(item.input);
      return filled(asText(item.output)) || (typeof item.input !== "string" && filled(input)) || argEntries(item.rawInput).length > 0;
    }
    case "file_change":
      return (
        filled(item.diffStr) ||
        filled(item.oldStr) ||
        filled(item.newStr) ||
        filled(item.errorText) ||
        item.additions !== undefined ||
        item.deletions !== undefined
      );
    case "file_search":
      return (item.results?.length ?? 0) > 0 || filled(item.errorText);
    case "web_search":
      return (item.results?.length ?? 0) > 0 || filled(item.errorText);
    case "todo_list":
      return item.steps.length > 0;
    case "approval_request":
      return filled(item.prompt);
    case "user_input_request":
      return item.questions.length > 0;
    case "error":
      return filled(item.failure.message);
    case "system_notice":
      // The label is the message; opening only helps when the row would cut it.
      return item.message.includes("\n") || item.message.trim().length > NOTICE_LABEL_CHARS;
    default:
      return false;
  }
}

function OutputBlock({
  text,
  truncated,
  label = "Output",
  diff = false,
}: {
  text: string;
  truncated?: boolean | undefined;
  label?: string;
  diff?: boolean;
}) {
  const capped = capLines(text);
  return (
    <div className="space-y-1">
      <pre
        aria-label={label}
        className={cn("max-h-80 overflow-auto whitespace-pre-wrap wrap-anywhere text-muted-foreground select-text", monoClassName)}
      >
        {diff
          ? capped.text.split("\n").map((line, index, lines) => (
              <span key={index} className={diffLineClassName(line)} data-diff-line={diffLineClassName(line) ? line[0] : undefined}>
                {index < lines.length - 1 ? `${line}\n` : line}
              </span>
            ))
          : capped.text}
      </pre>
      {capped.hidden > 0 ? (
        <p className="text-2xs text-muted-foreground italic" data-output-note="lines">
          {capped.hidden} more {capped.hidden === 1 ? "line" : "lines"} not shown. Open the Terminal tab for the rest.
        </p>
      ) : null}
      {truncated ? (
        <p className="text-2xs text-muted-foreground italic" data-output-note="truncated">
          The journal cut this output; the full text is in the agent's own log.
        </p>
      ) : null}
    </div>
  );
}

export function ToolItemDetail({ item }: { item: TurnItem }) {
  return (
    <div className="space-y-2 text-xs" data-tool-detail={item.type}>
      {item.type === "command_execution" ? (
        <div className={cn("space-y-1.5", monoClassName)}>
          <div className="whitespace-pre-wrap wrap-anywhere text-foreground/85">{commandDisplayText(item.input)}</div>
          {item.output !== undefined && item.output.trim() ? (
            <OutputBlock text={item.output} truncated={item.truncated} />
          ) : null}
          {item.exitCode !== undefined && item.exitCode !== 0 ? <div className="text-warning">exit {item.exitCode}</div> : null}
        </div>
      ) : null}

      {item.type === "dynamic_tool" ? (
        <div className={cn("space-y-1.5", monoClassName)}>
          {typeof item.input === "string" ? (
            item.input.trim() ? (
              <div className="whitespace-pre-wrap wrap-anywhere text-foreground/85">
                <span className="text-muted-foreground">{item.toolName ?? "tool"} </span>
                {item.input}
              </div>
            ) : null
          ) : asText(item.input) ? (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere text-foreground/85">{asText(item.input)}</pre>
          ) : null}
          {argEntries(item.rawInput).length > 0 ? (
            <dl aria-label="Arguments" className="max-h-60 space-y-1 overflow-auto">
              {argEntries(item.rawInput).map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="inline text-muted-foreground">{key}: </dt>
                  <dd className="inline whitespace-pre-wrap wrap-anywhere text-foreground/85">{capLines(value, 20).text}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {asText(item.output)?.trim() ? <OutputBlock text={asText(item.output)!} truncated={item.truncated} /> : null}
        </div>
      ) : null}

      {item.type === "file_change" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 wrap-anywhere font-mono text-muted-foreground">{item.fileName}</span>
            {item.additions !== undefined || item.deletions !== undefined ? (
              <DiffStatLabel additions={item.additions ?? 0} deletions={item.deletions ?? 0} layout="inline" />
            ) : null}
            {item.diffStr?.trim() ? <MessageCopyButton text={item.diffStr} variant="ghost" /> : null}
          </div>
          {item.errorText?.trim() ? <OutputBlock text={item.errorText} label="Error" /> : null}
          {item.diffStr?.trim() ? <OutputBlock text={item.diffStr} truncated={item.truncated} label="Diff" diff /> : null}
          {!item.diffStr?.trim() && item.oldStr?.trim() ? <OutputBlock text={item.oldStr} label="Before" /> : null}
          {!item.diffStr?.trim() && item.newStr?.trim() ? <OutputBlock text={item.newStr} label="After" /> : null}
        </div>
      ) : null}

      {item.type === "todo_list" ? (
        <ul aria-label="Tasks" className="space-y-1">
          {item.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-start gap-2" data-step-status={step.status}>
              <TodoStepIcon status={step.status} />
              <span
                className={cn(
                  "min-w-0 wrap-anywhere",
                  step.status === "completed" ? "text-muted-foreground line-through" : "text-foreground/85",
                  step.status === "running" && "font-medium text-foreground",
                )}
              >
                <span className="sr-only">{TODO_STATUS_LABEL[step.status]}: </span>
                {step.text}
              </span>
            </li>
          ))}
          {item.truncated ? (
            <li className="text-2xs text-muted-foreground italic">The journal cut this list; the full list is in the agent's own log.</li>
          ) : null}
        </ul>
      ) : null}

      {(item.type === "file_search" || item.type === "web_search") && item.errorText?.trim() ? (
        <OutputBlock text={item.errorText} label="Error" />
      ) : null}

      {item.type === "file_search" && item.pattern?.trim() ? (
        <div className={cn("wrap-anywhere text-foreground/85", monoClassName)}>{item.pattern}</div>
      ) : null}
      {item.type === "file_search" && item.results?.length ? (
        <ul className={cn("max-h-80 space-y-1 overflow-auto wrap-anywhere", monoClassName)}>
          {item.results.slice(0, MAX_OUTPUT_LINES).map((result, index) => (
            <li key={`${result.fileName}:${result.line ?? ""}:${index}`}>
              <span className="text-foreground/80">
                {result.fileName}
                {result.line === undefined ? "" : `:${result.line}`}
              </span>
              {result.preview ? <span className="text-muted-foreground"> {result.preview}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "web_search" && item.patterns?.length ? (
        <div className={cn("whitespace-pre-wrap wrap-anywhere text-foreground/85", monoClassName)}>{item.patterns.join("\n")}</div>
      ) : null}
      {item.type === "web_search" && item.results?.length ? (
        <ul className="space-y-1.5 wrap-anywhere">
          {item.results.map((result, index) => (
            <li key={`${result.url ?? ""}:${index}`}>
              {isSafeMarkdownHref(result.url) ? (
                <a href={result.url} target="_blank" rel="noopener noreferrer" className="font-medium text-info hover:underline">
                  {result.title ?? result.url}
                </a>
              ) : result.title ? (
                <p className="font-medium text-foreground">{result.title}</p>
              ) : null}
              {result.snippet ? <OutputBlock text={result.snippet} truncated={item.truncated} /> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {item.type === "approval_request" && item.prompt ? <OutputBlock text={item.prompt} label="Prompt" /> : null}
      {item.type === "user_input_request" ? (
        <OutputBlock text={item.questions.map((question) => question.question).join("\n\n")} label="Questions" />
      ) : null}
      {item.type === "error" ? <OutputBlock text={item.failure.message} label="Error" /> : null}
      {item.type === "system_notice" ? <OutputBlock text={item.message} label="Notice" /> : null}
    </div>
  );
}
