/**
 * The slash menu above the box (T12), on the model of T3's `ComposerCommandMenu`: a listbox of
 * `ComposerCommandItem`s with an active row the box's arrow keys move, `composerSuggestionOptionId`
 * for `aria-activedescendant`, and pointer-down that never steals the box's focus. Only the slash
 * trigger exists here (no paths, skills, pull requests or threads), and it is a plain ARIA listbox,
 * not T3's `ui/command`.
 */
import { memo, useLayoutEffect, useRef } from "react";

import type { AgentCommand } from "@shared/agents";
import { cn } from "~/lib/utils";

export interface ComposerCommandItem {
  id: string;
  type: "slash-command";
  command: AgentCommand;
  label: string;
  description: string;
}

export function toCommandItems(commands: readonly AgentCommand[]): ComposerCommandItem[] {
  return commands.map((command) => ({
    id: command.command,
    type: "slash-command",
    command,
    label: command.command,
    description: command.description,
  }));
}

export function composerSuggestionOptionId(listId: string, itemId: string): string {
  // As T3: JSON escapes lone UTF-16 surrogates before URI encoding without losing identity.
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  activeItemId: string | null;
  /** The dangerous command waiting for its second tap. */
  armedItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <div
      ref={listRef}
      className="max-h-72 overflow-y-auto rounded-xl border bg-card p-1 shadow-sm"
      data-composer-command-drawer="true"
    >
      {props.items.length > 0 ? (
        <div id={props.listId} role="listbox" aria-label="Commands">
          {props.items.map((item) => {
            const active = props.activeItemId === item.id;
            const armed = props.armedItemId === item.id;
            return (
              <div
                key={item.id}
                id={composerSuggestionOptionId(props.listId, item.id)}
                role="option"
                aria-selected={active}
                data-composer-item-id={item.id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 sm:min-h-9",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  armed && "bg-warning-surface text-warning",
                )}
                onMouseMove={() => {
                  if (!active) props.onHighlightedItemChange(item.id);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onSelect(item)}
              >
                <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-xs font-medium">
                  {item.label}
                  {item.command.takesArg && item.command.argHint ? (
                    <span className="ms-1 text-muted-foreground">{item.command.argHint}</span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">
                  {armed ? "Tap again to run" : item.description}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">No matching command.</p>
      )}
    </div>
  );
});
