import { useEffect, useRef, useState } from "react";
import { Pencil, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionPopover } from "@/components/ui/popover";
import { useDesktop } from "@/lib/desktop";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";
import { paneDisplayName } from "@/lib/types";
import type { AgentView } from "@/lib/types";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent navigates Home if it's the
   *  pane currently open, or revalidates so it drops out of the list. */
  onClosed: (paneId: string) => void;
  anchor?: { x: number; y: number } | null;
}

type Mode = "actions" | "rename";

/**
 * Rename + close for one pane, shared by the tree's pane sheet and the pane menu behind the header
 * title, so the two can't drift. `onDone` closes whatever surface hosts the rows.
 */
export function usePaneActions({
  open,
  pane,
  onRenamed,
  onClosed,
  onDone,
}: {
  open: boolean;
  pane: AgentView | null;
  onRenamed: () => void;
  onClosed: (paneId: string) => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset to the action list — and reprefill the label — whenever the host opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next);
      if (res.ok) {
        setStatus(next ? "Renamed" : "Label cleared", "success");
        onRenamed();
        onDone();
      } else {
        setStatus(res.error ?? "Rename failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // Two-tap: the first tap arms (row flips to "Tap again to close"), the second closes.
  async function requestClose() {
    if (!pane || closing) return;
    if (!confirm(pane.paneId)) return;
    setClosing(true);
    try {
      const res = await api.closePane(pane.paneId);
      if (res.ok) {
        onDone();
        onClosed(pane.paneId);
      } else {
        setStatus(res.error ?? "Close failed", "error");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setClosing(false);
    }
  }

  const confirming = !!pane && pending === pane.paneId;

  const renameRow = (
    <ActionRow
      icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
      label="Rename"
      onClick={() => setMode("rename")}
    />
  );
  const closeRow = (
    <DestructiveActionRow
      icon={<XCircle className="size-4 shrink-0" />}
      label="Close pane"
      confirmLabel="Tap again to close"
      closingLabel="Closing…"
      armed={confirming}
      closing={closing}
      onClick={() => void requestClose()}
    />
  );
  const renameView = (
    <RenameView
      inputRef={inputRef}
      label={label}
      onLabelChange={setLabel}
      onSave={() => void save()}
      onBack={() => setMode("actions")}
      saving={saving}
      // A blank pane field clears the label (blank → null on the bridge), so Save stays enabled.
      canSave={true}
      placeholder="name this pane"
    />
  );
  return { mode, renameRow, closeRow, renameView };
}

// Row actions for a single pane: rename (set/clear its label) and close (kill). Reached from a pane
// row's ⋯ (or right-click / long-press) in the Spaces tree; the open pane's own copy lives in the
// pane menu behind the header title. Rename is a second tap away so the sheet doesn't shove a
// keyboard-triggering input at you just to close a pane. The label is user text rendered only into
// an <input> value / text node — never markup. Both actions are writes, so under read-only they're
// replaced by a note.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  readOnly = false,
  onRenamed,
  onClosed,
  anchor = null,
}: PaneActionsSheetProps) {
  const desktop = useDesktop().on;
  const actions = usePaneActions({ open, pane, onRenamed, onClosed, onDone: onClose });

  const title = pane ? paneDisplayName(pane) : "Pane";
  const body = readOnly ? (
    <p className="py-2 text-sm text-muted-foreground">
      Read-only — this device isn't authorised to rename or close panes.
    </p>
  ) : actions.mode === "actions" ? (
    <div className="flex flex-col gap-1">
      {actions.renameRow}
      {actions.closeRow}
    </div>
  ) : (
    actions.renameView
  );
  return desktop ? (
    <ActionPopover open={open} onClose={onClose} anchor={anchor} title={title}>{body}</ActionPopover>
  ) : (
    <BottomSheet open={open} onClose={onClose} title={title}>{body}</BottomSheet>
  );
}
