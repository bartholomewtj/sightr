/**
 * The project row's menu (right click, `Space` on the row, or a long press on touch): Rename. The inline field mirrors the
 * thread row's: Enter sends `project.rename`, Escape cancels, an empty name is refused.
 */
import { useEffect, useRef, useState } from "react";

import { Menu, MenuItem, MenuPopup } from "~/components/ui/menu";

import type { Project } from "@shared/v2/contracts";
import { cn } from "@/lib/utils";

export function ProjectRowMenu({
  project,
  anchor,
  onClose,
  onRename,
}: {
  project: Project | null;
  anchor: HTMLElement | null;
  onClose(): void;
  onRename(projectId: string): void;
}) {
  const open = project !== null && anchor !== null;
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <MenuPopup anchor={anchor} align="start" side="bottom" aria-label={`Actions for ${project.label}`}>
          <MenuItem className="pointer-coarse:min-h-11" onClick={() => onRename(project.id)}>
            Rename
          </MenuItem>
        </MenuPopup>
      ) : null}
    </Menu>
  );
}

export function ProjectRenameField({ label, onDone, onCommit }: { label: string; onDone(): void; onCommit(label: string): void }) {
  const [value, setValue] = useState(label);
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // After the menu has closed and handed focus back.
    const id = setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="flex min-w-0 flex-1 items-center py-1 pl-3">
      <input
        ref={ref}
        aria-label="Project name"
        aria-invalid={invalid || undefined}
        className={cn(
          "h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring sm:text-sm pointer-coarse:h-10",
          invalid && "border-warn",
        )}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const next = value.trim();
            if (!next) {
              setInvalid(true);
              return;
            }
            if (next !== label) onCommit(next);
            onDone();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        onBlur={onDone}
      />
    </div>
  );
}
