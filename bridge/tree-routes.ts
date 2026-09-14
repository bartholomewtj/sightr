import { homedir } from "node:os";
import { SILENT_AUDIT, type AuditLog } from "./audit.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { herdrErrorCode } from "./herdr-client.ts";
import type { StateEngine } from "./state-engine.ts";
import type { ActionResponse, CreateResponse } from "../shared/wire.ts";
import { failureText, json, requireJsonBody, text } from "./responses.ts";
import type { WorktreeIndex } from "./worktrees.ts";

function actionFailure(context: string, err: unknown): ActionResponse {
  const code = herdrErrorCode(err);
  if (code === "workspace_group_close_required") {
    return { ok: false, error: "close the worktree group", code };
  }
  if (code === "workspace_not_found" || code === "not_git_worktree") {
    return { ok: false, error: failureText(context, err), code };
  }
  if (/force|--force|not clean|modified or untracked|dirty/i.test(String(err))) {
    return { ok: false, error: "checkout is dirty", code: "worktree_dirty" };
  }
  return { ok: false, error: failureText(context, err), ...(code ? { code } : {}) };
}

export function normalizeLabel(
  v: unknown,
): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof v !== "string") return { ok: false, error: "bad label" };
  const label = v.trim();
  if (!label) return { ok: false, error: "label required" };
  return { ok: true, label };
}

// Set a tab's label. Structural metadata op — strictly less powerful than the text/keys injection the
// bridge already allows, so it stays within the existing remote-shell threat model. A tab has no
// "clear" (see normalizeLabel): a blank label is a 400, not a reset to the tab number.
export async function renameTab(
  herdr: HerdrClient,
  tabId: string,
  req: Request,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  const ae = req.headers.get("accept-encoding");
  let body: { label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const parsed = normalizeLabel(body.label);
  if (!parsed.ok) return text(parsed.error, 400);
  try {
    await herdr.renameTab(tabId, parsed.label);
    audit.record({ action: "tab.rename", detail: { tabId, label: parsed.label } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("rename tab", err) } satisfies ActionResponse, ae);
  }
}

// Set a workspace's label. Structural metadata op — same threat model as tab.rename, so the same
// write guard. A workspace has no "clear" (see normalizeLabel): a blank label is a 400.
export async function renameWorkspace(
  herdr: HerdrClient,
  workspaceId: string,
  req: Request,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  const ae = req.headers.get("accept-encoding");
  let body: { label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const parsed = normalizeLabel(body.label);
  if (!parsed.ok) return text(parsed.error, 400);
  try {
    await herdr.renameWorkspace(workspaceId, parsed.label);
    audit.record({ action: "workspace.rename", detail: { workspaceId, label: parsed.label } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("rename space", err) } satisfies ActionResponse, ae);
  }
}

// Close a tab, killing every pane inside it (live-verified 2026-07-19: the tab's panes disappear with
// it — see HERDR_API.md). Structural op — no more powerful than closing those panes one-by-one, which
// the bridge already allows via pane.close — so it stays within the existing remote-shell threat
// model. No body: the tab id is in the path.
export async function closeTab(
  herdr: HerdrClient,
  tabId: string,
  req: Request,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await herdr.closeTab(tabId);
    audit.record({ action: "tab.close", detail: { tabId } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("close tab", err) } satisfies ActionResponse, ae);
  }
}

// Close a workspace (every tab + pane inside it). Optional `closeGroup` closes the whole linked
// worktree group — Herdr requires it on the primary while children are open. Body is JSON so a
// cross-site POST without a preflight cannot set it. Invalidates the worktree cache so the next
// snapshot does not keep showing the closed checkout as open.
export async function closeWorkspace(
  herdr: HerdrClient,
  workspaceId: string,
  req: Request,
  worktrees?: WorktreeIndex,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  const ae = req.headers.get("accept-encoding");
  let body: { closeGroup?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const closeGroup = body.closeGroup === true;
  try {
    await herdr.closeWorkspace(workspaceId, { closeGroup });
    worktrees?.invalidate();
    audit.record({ action: "workspace.close", detail: { workspaceId, closeGroup } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json(actionFailure("close space", err), ae);
  }
}

// Delete a linked worktree checkout (`git worktree remove`). `force` retries a dirty tree.
export async function removeWorktree(
  herdr: HerdrClient,
  workspaceId: string,
  req: Request,
  worktrees?: WorktreeIndex,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  const ae = req.headers.get("accept-encoding");
  let body: { force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  try {
    await herdr.removeWorktree(workspaceId, { force: body.force === true });
    worktrees?.invalidate();
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    return json(actionFailure("delete worktree", err), ae);
  }
}

// Open an existing Git worktree as a workspace, grouped with the parent. Same create-response
// shape as createWorkspace so the client can jump into the new shell.
export async function openWorktree(
  herdr: HerdrClient,
  req: Request,
  worktrees?: WorktreeIndex,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { workspaceId?: string; cwd?: string; path?: string; branch?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const workspaceId = body.workspaceId?.trim();
  const cwd = body.cwd?.trim();
  const path = body.path?.trim();
  const branch = body.branch?.trim();
  if (!workspaceId && !cwd) {
    return json({ ok: false, error: "workspaceId or cwd required" } satisfies CreateResponse, ae);
  }
  if (!path && !branch) {
    return json({ ok: false, error: "path or branch required" } satisfies CreateResponse, ae);
  }
  try {
    const created = await herdr.openWorktree({ workspaceId, cwd, path, branch });
    worktrees?.invalidate();
    return json({
      ok: true,
      pane: {
        paneId: created.paneId,
        workspaceId: created.workspaceId,
        workspaceLabel: created.workspaceLabel ?? created.workspaceId,
        tabId: created.tabId,
        cwd: created.cwd,
      },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("open worktree", err) } satisfies CreateResponse, ae);
  }
}

// Create a new tab in a workspace, opening a fresh shell pane (you then launch your own agent in
// it). Structural — no more privilege than typing into an existing pane (you can already spawn a
// shell that way). `cwd` omitted => inherits the workspace dir. session.* stays unexposed.
export async function createTab(
  herdr: HerdrClient,
  engine: StateEngine,
  req: Request,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { workspaceId?: string; label?: string; cwd?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const workspaceId = body.workspaceId?.trim();
  const ae = req.headers.get("accept-encoding");
  if (!workspaceId) return json({ ok: false, error: "workspaceId required" } satisfies CreateResponse, ae);
  try {
    const created = await herdr.createTab(workspaceId, { label: body.label, cwd: body.cwd });
    const label =
      engine.current().workspaces.find((w) => w.workspaceId === created.workspaceId)?.label ??
      created.workspaceId;
    audit.record({
      action: "tab.create",
      paneId: created.paneId,
      detail: { workspaceId, label: body.label, cwd: body.cwd },
    });
    return json({
      ok: true,
      pane: { ...created, workspaceLabel: label },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("create tab", err) } satisfies CreateResponse, ae);
  }
}

// Create a new workspace ("space") with a fresh shell pane. `cwd` defaults to the user's home dir
// when the client doesn't specify one (typing a path on a phone is painful) — it's a shell, so you
// can cd from there. Same structural-only threat model as createTab.
export async function createWorkspace(
  herdr: HerdrClient,
  req: Request,
  worktrees?: WorktreeIndex,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { cwd?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const cwd = body.cwd?.trim() || homedir();
  const ae = req.headers.get("accept-encoding");
  try {
    const created = await herdr.createWorkspace({ cwd, label: body.label });
    worktrees?.invalidate();
    audit.record({
      action: "workspace.create",
      paneId: created.paneId,
      detail: { label: body.label, cwd },
    });
    return json({
      ok: true,
      pane: {
        paneId: created.paneId,
        workspaceId: created.workspaceId,
        workspaceLabel: created.workspaceLabel ?? created.workspaceId,
        tabId: created.tabId,
        cwd: created.cwd,
      },
    } satisfies CreateResponse, ae);
  } catch (err) {
    return json({ ok: false, error: failureText("create space", err) } satisfies CreateResponse, ae);
  }
}

// Save an uploaded image to a host file and return its absolute path. The client then references
// that path in a message; Claude Code reads images by path (the terminal can't take a
// pasted image over the socket). Validated by SIZE and by its MAGIC BYTES — never by the declared
