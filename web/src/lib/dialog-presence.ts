// Which panes Sightr has SEEN holding a parsed ask card (#372). The snapshot carries no screen text,
// so the only parse the browser runs is the open pane's (hooks/use-pane-view.ts). That parse reports
// here, and the root loader stamps `dialogPresent` onto the herd (lib/loaders.ts → toHomeData), which
// is what lets bucketOf put a Grok ask Herdr calls "working" into Needs you.
import type { Block } from "./blocks";
import type { DialogKind } from "./harness/dialog-contract";
import type { AgentStatus, AgentView } from "./types";

const DIALOG_KINDS: Record<DialogKind, true> = {
  "prompt-select": true,
  wizard: true,
  "preview-select": true,
  "multi-select": true,
  menu: true,
};

export function hasParsedDialog(blocks: readonly Block[]): boolean {
  return blocks.some((b) => Object.hasOwn(DIALOG_KINDS, b.kind));
}

const seen = new Map<string, { status: AgentStatus; lastActiveAt: number | undefined }>();
const MAX_PANES = 20;

export function noteDialogPresence(
  paneId: string,
  dialog: boolean,
  agent: Pick<AgentView, "status" | "lastActiveAt"> | undefined,
): boolean {
  if (!dialog || !agent) {
    return seen.delete(paneId);
  }
  const existing = seen.get(paneId);
  if (
    existing &&
    existing.status === agent.status &&
    existing.lastActiveAt === agent.lastActiveAt
  ) {
    return false;
  }
  seen.delete(paneId);
  seen.set(paneId, { status: agent.status, lastActiveAt: agent.lastActiveAt });
  if (seen.size > MAX_PANES) {
    const oldestKey = seen.keys().next().value;
    if (oldestKey !== undefined) {
      seen.delete(oldestKey);
    }
  }
  return true;
}

export function withDialogPresence(agents: AgentView[]): AgentView[] {
  if (seen.size === 0) return agents;

  const agentIds = new Set(agents.map((a) => a.paneId));
  for (const paneId of seen.keys()) {
    if (!agentIds.has(paneId)) {
      seen.delete(paneId);
    }
  }

  if (seen.size === 0) return agents;

  let anyModified = false;
  const result = agents.map((a) => {
    const entry = seen.get(a.paneId);
    if (!entry) return a;
    if (entry.status !== a.status || entry.lastActiveAt !== a.lastActiveAt) {
      seen.delete(a.paneId);
      return a;
    }
    anyModified = true;
    return { ...a, dialogPresent: true };
  });

  return anyModified ? result : agents;
}

/** Reset the dialog presence store. For tests only. */
export function resetDialogPresence(): void {
  seen.clear();
}
