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
 */
import type { TurnItem } from "@shared/v2/contracts";

import { cn } from "~/lib/utils";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";

import { isSafeMarkdownHref } from "../ChatMarkdown";

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
      return filled(asText(item.output)) || (typeof item.input !== "string" && filled(input));
    }
    case "file_change":
      return filled(item.diffStr) || filled(item.oldStr) || filled(item.newStr) || item.additions !== undefined || item.deletions !== undefined;
    case "file_search":
      return (item.results?.length ?? 0) > 0;
    case "web_search":
      return (item.results?.length ?? 0) > 0;
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
          {asText(item.output)?.trim() ? <OutputBlock text={asText(item.output)!} truncated={item.truncated} /> : null}
        </div>
      ) : null}

      {item.type === "file_change" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 wrap-anywhere font-mono text-muted-foreground">{item.fileName}</span>
            {item.additions !== undefined || item.deletions !== undefined ? (
              <span className="font-mono">
                <span className="text-success">+{item.additions ?? 0}</span>{" "}
                <span className="text-destructive">-{item.deletions ?? 0}</span>
              </span>
            ) : null}
          </div>
          {item.diffStr?.trim() ? <OutputBlock text={item.diffStr} truncated={item.truncated} label="Diff" diff /> : null}
          {!item.diffStr?.trim() && item.oldStr?.trim() ? <OutputBlock text={item.oldStr} label="Before" /> : null}
          {!item.diffStr?.trim() && item.newStr?.trim() ? <OutputBlock text={item.newStr} label="After" /> : null}
        </div>
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
