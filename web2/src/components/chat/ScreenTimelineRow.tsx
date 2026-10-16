/**
 * A `screen` turn item (T03, Sightr only): the pane's last screen, captured when a run ends on a
 * harness with no journal. A bordered Consolas block in the mirror's colour space, rendered through
 * v1's ANSI parser (`@v1/lib/ansi`, SGR only, every run a text node) without v1's block grammars.
 * Capped at {@link SCREEN_PREVIEW_LINES} lines with "Show all".
 *
 * The two class strings are v1's `MIRROR_SPACE` / `MIRROR_INVERT` (web/src/components/mirror-space.ts,
 * ADR 0002): terminal colour is dark-space colour, so the block is dark under every theme and the
 * light theme inverts it wholesale. Spelled here so Tailwind sees them in web2's sources.
 */
import { memo, useMemo, useState } from "react";

import { parseAnsi, type AnsiSegment } from "@v1/lib/ansi";

import { cn } from "~/lib/utils";

export const SCREEN_PREVIEW_LINES = 40;

const MIRROR_SPACE = "[color-scheme:dark] bg-[#0a0a0a] text-[#fafafa]";
const MIRROR_INVERT = "[filter:invert(1)_hue-rotate(180deg)] dark:[filter:none]";

function styleFor(s: AnsiSegment) {
  return s.muted ? { ...s.style, color: "#a1a1a1", fontWeight: 400, opacity: 1 } : s.style;
}

/** The screen text with trailing blank lines dropped, and its line count. */
export function screenLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)!.replace(/\u001b\[[0-9;]*m/g, "").trim() === "") lines.pop();
  return lines;
}

export const ScreenTimelineRow = memo(function ScreenTimelineRow({ text, capturedAt }: { text: string; capturedAt: number }) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => screenLines(text), [text]);
  const hidden = Math.max(0, lines.length - SCREEN_PREVIEW_LINES);
  // The tail is the useful part of a screen: when capped, show its last lines.
  const shown = showAll || hidden === 0 ? lines : lines.slice(hidden);
  const segments = useMemo(() => parseAnsi(shown.join("\n")), [shown]);
  return (
    <section aria-label="Screen at end of run" className="space-y-1" data-screen-item="true">
      <div className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
        <span className="font-medium">Screen at end of run</span>
        <span className="font-mono tabular-nums">
          {new Date(capturedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <pre
        className={cn(
          "m-0 max-w-full overflow-x-auto rounded-lg border border-border p-3 font-mono text-xs leading-[1.25] whitespace-pre",
          MIRROR_SPACE,
          MIRROR_INVERT,
        )}
      >
        {segments.map((segment, index) => (
          <span key={index} style={styleFor(segment)}>
            {segment.text}
          </span>
        ))}
      </pre>
      {hidden > 0 ? (
        <button
          type="button"
          className="px-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "Show less" : `Show all (${lines.length} lines)`}
        </button>
      ) : null}
    </section>
  );
});
