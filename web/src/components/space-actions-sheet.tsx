import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionPopover } from "@/components/ui/popover";
import { useDesktop } from "@/lib/desktop";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { WorkspaceView } from "@/lib/types";

interface SpaceActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The space these actions target. Null while nothing is selected (sheet closed). */
  workspace: WorkspaceView | null;
  /** Open linked-worktree children of this space — Close then sends closeGroup. */
  linkedChildCount?: number;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate. */
  onRenamed: () => void;
  /** Fired after a successful close/remove, with the closed workspace id. */
  onClosed: (workspaceId: string) => void;
  anchor?: { x: number; y: number } | null;
}

type Mode = "actions" | "rename";

// Row actions for a single space (⋯ button or right-click) — same structure as the tab sheet:
// Rename, Close space, and on a linked worktree child, Delete checkout. Close is Herdr's
// workspace.close (group close when this row has open linked children). Delete checkout is
// worktree.remove — git worktree remove, never the branch. Two-tap confirm on both destructive
// rows, matching panes/tabs. A dirty checkout re-arms as force. Like a tab, a space has no
// "clear" (herdr requires a non-empty string), so a blank field can't be saved.
export function SpaceActionsSheet({
  open,
  onClose,
  workspace,
  linkedChildCount = 0,
  readOnly = false,
  onRenamed,
  onClosed,
  anchor = null,
}: SpaceActionsSheetProps) {
  const desktop = useDesktop().on;
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [needForce, setNeedForce] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) space,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(workspace?.label ?? "");
    setNeedForce(false);
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspace?.workspaceId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  const trimmed = label.trim();
  const isLinked = !!workspace?.worktree?.isLinkedWorktree;
  const groupCount = 1 + linkedChildCount;

  async function save() {
    if (!workspace || saving || !trimmed) return;
    setSaving(true);
    try {
      const res = await api.renameSpace(workspace.workspaceId, trimmed);
      if (res.ok) {
        setStatus("Renamed", "success");
        onRenamed();
        onClose();
      } else {
        setStatus(res.error ?? "Rename failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function requestClose() {
    if (!workspace || closing) return;
    if (!confirm(`close:${workspace.workspaceId}`)) return;
    setClosing(true);
    try {
      const res = await api.closeSpace(workspace.workspaceId, { closeGroup: linkedChildCount > 0 });
      if (res.ok) {
        onClose();
        onClosed(workspace.workspaceId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  async function requestRemove() {
    if (!workspace || removing) return;
    const id = needForce ? `force:${workspace.workspaceId}` : `remove:${workspace.workspaceId}`;
    if (!confirm(id)) return;
    setRemoving(true);
    try {
      const res = await api.removeWorktree(workspace.workspaceId, { force: needForce });
      if (res.ok) {
        onClose();
        onClosed(workspace.workspaceId);
      } else if (res.code === "worktree_dirty") {
        setNeedForce(true);
        confirm(`force:${workspace.workspaceId}`);
        setStatus("Checkout is dirty", "error");
      } else {
        setStatus(res.error ?? "Delete failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRemoving(false);
    }
  }

  const confirmingClose = !!workspace && pending === `close:${workspace.workspaceId}`;
  const confirmingRemove = !!workspace && (
    pending === `remove:${workspace.workspaceId}` || pending === `force:${workspace.workspaceId}`
  );
  const paneCount = workspace?.paneCount ?? 0;
  const closeLabel = linkedChildCount > 0 ? "Close group" : "Close space";
  const closeConfirm =
    linkedChildCount > 0
      ? `Tap again to close ${groupCount} spaces`
      : paneCount > 0
        ? `Tap again to close ${paneCount} pane${paneCount === 1 ? "" : "s"}`
        : "Tap again to close";
  const removeLabel = needForce ? "Force delete checkout" : "Delete checkout";
  const removeConfirm = needForce ? "Tap again to force delete" : "Tap again to delete checkout";

  const title = workspace ? `Space ${workspace.label}` : "Space";
  const body = readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">
          Read-only — this device isn't authorised to rename or close spaces.
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          <ActionRow
            icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
            label="Rename"
            onClick={() => setMode("rename")}
          />
          <DestructiveActionRow
            icon={<XCircle className="size-4 shrink-0" />}
            label={closeLabel}
            confirmLabel={closeConfirm}
            closingLabel="Closing…"
            armed={confirmingClose}
            closing={closing}
            onClick={() => void requestClose()}
          />
          {isLinked && (
            <DestructiveActionRow
              icon={<Trash2 className="size-4 shrink-0" />}
              label={removeLabel}
              confirmLabel={removeConfirm}
              closingLabel="Deleting…"
              armed={confirmingRemove}
              closing={removing}
              onClick={() => void requestRemove()}
            />
          )}
        </div>
      ) : (
        <RenameView
          inputRef={inputRef}
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onBack={() => setMode("actions")}
          saving={saving}
          // A space has no "clear" (herdr requires a non-empty string), so a blank field can't be
          // saved — Save disables.
          canSave={!!trimmed}
          placeholder="name this space"
        />
      );
  return desktop ? (
    <ActionPopover open={open} onClose={onClose} anchor={anchor} title={title}>{body}</ActionPopover>
  ) : (
    <BottomSheet open={open} onClose={onClose} title={title}>{body}</BottomSheet>
  );
}
