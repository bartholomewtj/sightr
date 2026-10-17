// Adapted from T3 Code apps/web/src/components/CommandPaletteResults.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: the plain (non-virtualized) list only, since a herd is a few dozen threads; no thread
// content-match excerpt and no submenu rows; 44 px rows on touch. Row markup and classes are T3's.
import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { shortcutLabelForCommand } from "../keybindings";
import { type CommandPaletteActionItem, type CommandPaletteGroup } from "./CommandPalette.logic";
import { CommandCollection, CommandGroup, CommandGroupLabel, CommandItem, CommandList, CommandShortcut } from "./ui/command";

interface CommandPaletteResultsProps {
  emptyStateMessage?: string;
  groups: ReadonlyArray<CommandPaletteGroup>;
  highlightedItemValue?: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem) => void;
}

function CommandPaletteEmptyState(props: { emptyStateMessage?: string }) {
  return (
    <div className="py-10 text-center text-sm text-muted-foreground">
      {props.emptyStateMessage ?? "No matching threads, projects or actions."}
    </div>
  );
}

export function CommandPaletteResults(props: CommandPaletteResultsProps) {
  if (props.groups.length === 0) {
    return <CommandPaletteEmptyState {...(props.emptyStateMessage ? { emptyStateMessage: props.emptyStateMessage } : {})} />;
  }

  return (
    <CommandList>
      {props.groups.map((group) => (
        <CommandGroup items={group.items} key={group.value}>
          {group.label ? <CommandGroupLabel>{group.label}</CommandGroupLabel> : null}
          <CommandCollection>
            {(item: CommandPaletteActionItem) =>
              item.disabled ? (
                <DisabledCommandPaletteResultRow item={item} key={item.value} />
              ) : (
                <CommandPaletteResultRow
                  item={item}
                  key={item.value}
                  keybindings={props.keybindings}
                  isActive={props.highlightedItemValue === item.value}
                  onExecuteItem={props.onExecuteItem}
                />
              )
            }
          </CommandCollection>
        </CommandGroup>
      ))}
    </CommandList>
  );
}

function RowBody({ item }: { item: CommandPaletteActionItem }) {
  return item.description ? (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
        {item.titleLeadingContent}
        <span className="truncate">{item.title}</span>
      </span>
      <span className="min-w-0 truncate text-muted-foreground/70 text-xs">{item.description}</span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-foreground">
      {item.titleLeadingContent}
      <span className="truncate">{item.title}</span>
    </span>
  );
}

function DisabledCommandPaletteResultRow(props: { item: CommandPaletteActionItem }) {
  return (
    <div className="flex min-h-8 select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base opacity-64 sm:min-h-7 sm:text-sm pointer-coarse:min-h-11">
      {props.item.icon}
      <RowBody item={props.item} />
      {props.item.titleTrailingContent}
    </div>
  );
}

function CommandPaletteResultRow(props: {
  item: CommandPaletteActionItem;
  isActive: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onExecuteItem: (item: CommandPaletteActionItem) => void;
}) {
  const shortcutLabel = props.item.shortcutCommand ? shortcutLabelForCommand(props.keybindings, props.item.shortcutCommand) : null;
  return (
    <CommandItem
      value={props.item.value}
      active={props.isActive}
      className="pointer-coarse:min-h-11"
      data-palette-item={props.item.value}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onExecuteItem(props.item);
      }}
    >
      {props.item.icon}
      <RowBody item={props.item} />
      {props.item.titleTrailingContent}
      {props.item.timestamp ? (
        <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">{props.item.timestamp}</span>
      ) : null}
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}
