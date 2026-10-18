// Same job and name as T3 Code apps/web/src/components/ThreadSearchMatch.tsx @ db5919d87 (pattern; MIT,
// see THIRD_PARTY.md): the one-line excerpt under a thread in the palette, "You:" or "Agent:" in front,
// the matched words in bold. T3 finds the words in the snippet itself; here the bridge's search sends
// the excerpt with the ranges it matched (`ThreadSearchMatch.ranges`), and a command input is "Ran:".
import type { SearchRole, ThreadSearchMatch } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";

import { HighlightedSearchLine } from "./HighlightedSearchLine";

const LABEL: Record<SearchRole, { text: string; className: string }> = {
  user: { text: "You:", className: "text-info-foreground" },
  assistant: { text: "Agent:", className: "text-success-foreground" },
  tool: { text: "Ran:", className: "text-muted-foreground" },
};

export function ThreadSearchMatchExcerpt(props: { match: Pick<ThreadSearchMatch, "role" | "excerpt" | "ranges">; className?: string }) {
  const label = LABEL[props.match.role];
  return (
    <span className={cn("text-xs text-muted-foreground/85", props.className)} data-search-excerpt="">
      <span className={label.className}>{label.text}</span>{" "}
      <HighlightedSearchLine line={props.match.excerpt} ranges={props.match.ranges} />
    </span>
  );
}
