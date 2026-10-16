import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { buildLaunchArgs, launchFor } from "../../shared/agents.ts";
import type { CommandOf, Project } from "../../shared/v2/contracts.ts";
import { SILENT_AUDIT, type AuditLog } from "../audit.ts";
import { herdrErrorCode, type CreatedShell, type HerdrClient } from "../herdr-client.ts";
import type { JournalAdapter } from "../journal/types.ts";
import type { PaneQueue } from "../pane-queue.ts";
import { failureText } from "../responses.ts";
import type { StateEngine } from "../state-engine.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { MAX_TITLE_LENGTH } from "./decide.ts";
import type { EventDraft, ServerThread, ServerThreadPatch } from "./events.ts";
import type { ThreadStore } from "./store.ts";
import type { EffectHandler, EffectOutcome, EffectRegistry } from "./v2-routes.ts";

// Spawn (T07): `thread.create` makes a pane (a new tab, a split, or a new workspace's root pane) and
// starts the harness in it with herdr `agent.start`, using arguments built from the launch table in
// `shared/agents.ts`. `project.create` makes a workspace. Both are T05 effect handlers.
//
// The command answers as soon as the pane exists: `thread.created {status: "starting"}` commits with the
// receipt, so the sidebar shows the row while the agent boots. Everything after that (the shell prompt,
// the start, the failure clean-up) arrives as events carrying the same `commandId`.

/** The pane-queue key spawn and project.create take: one pane or workspace is made at a time. */
export const SPAWN_KEY = "v2:spawn";
/** How long the new pane's shell may take to draw its prompt. */
export const PROMPT_WAIT_MS = 10_000;
export const PROMPT_POLL_MS = 250;
/** `agent.start`'s wait for the agent to be ready. */
export const AGENT_START_TIMEOUT_MS = 45_000;
/** A pane that is not at a prompt yet (`agent_pane_busy`) is retried this many times, this far apart. */
export const BUSY_RETRIES = 3;
export const BUSY_RETRY_MS = 1_000;
/** A taken agent name gets ` -2`, `-3`, … this many times. */
export const NAME_RETRIES = 5;
/** After a start, how long to wait for the engine's snapshot to show the agent before the thread is set idle. */
export const SETTLE_MS = 3_000;
export const MAX_NAME_LENGTH = 80;
/** herdr's rule for an agent name (`valid_agent_name`). */
export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export interface SpawnDeps {
  store: Pick<ThreadStore, "append" | "getThread" | "getProject" | "listThreads" | "now" | "newId">;
  herdr: Pick<
    HerdrClient,
    | "createTab"
    | "createWorkspace"
    | "splitPane"
    | "startAgent"
    | "readPane"
    | "getPane"
    | "closePane"
    | "closeWorkspace"
    | "listWorkspaces"
  >;
  engine: Pick<StateEngine, "current" | "pokeNow" | "onUpdate">;
  queue: PaneQueue;
  journals: Record<string, JournalAdapter> | null;
  audit?: AuditLog;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** The real path of `cwd` when it is an existing directory, else null (test seam). */
  resolveDir?: (cwd: string) => Promise<string | null>;
  promptWaitMs?: number;
  startTimeoutMs?: number;
  settleMs?: number;
}

export interface Spawner {
  effects: EffectRegistry;
  /** Resolves when every background start has finished (tests). */
  settled(): Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────────────────────

/** A display name as a herdr agent name (`[a-z][a-z0-9_-]{0,31}`), or "" when nothing usable is left. */
export function agentNameFrom(display: string, harness: string): string {
  let slug = display
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (slug !== "" && !/^[a-z]/.test(slug)) slug = `${harness}-${slug}`;
  slug = slug.slice(0, 32).replace(/[-_]+$/, "");
  return AGENT_NAME.test(slug) ? slug : "";
}

/** `name` with a numeric suffix, cut so the whole stays a valid agent name. */
export function suffixedName(name: string, n: number): string {
  const tail = `-${n}`;
  return `${name.slice(0, 32 - tail.length).replace(/[-_]+$/, "")}${tail}`;
}

/** The last non-blank line of a screen read. */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] !== "") return lines[i]!;
  return "";
}

/** The real path of an existing local directory, or null. UNC paths are refused (no network lookups). */
export async function resolveLocalDir(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd) || /^[\\/]{2}/.test(cwd)) return null;
  try {
    const real = await realpath(cwd);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The operator's words for an `agent.start` failure; an unknown code keeps herdr's own message. */
const START_FAILURES: Record<string, string> = {
  agent_start_failed: "The agent exited before it was ready",
  agent_kind_mismatch: "A different agent started in the pane",
  agent_name_not_found: "The pane was taken over before the agent was ready",
  agent_pane_busy: "The pane is not at a shell prompt",
  agent_pane_not_found: "The pane closed before the agent started",
  agent_pane_unavailable: "The pane closed before the agent started",
  pane_not_found: "The pane closed before the agent started",
  unsupported_agent_kind: "herdr cannot start this harness",
  invalid_agent_argument: "herdr refused the launch arguments",
  invalid_agent_name: "herdr refused the agent name",
  agent_name_taken: "The agent name is already in use",
};

export function startFailureText(err: unknown): string {
  const code = herdrErrorCode(err);
  if (code && START_FAILURES[code]) return START_FAILURES[code]!;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(/^herdr [^\s:]+: (?:[a-z0-9_]+: )?/i, "").trim();
  return `spawn-failed: ${message || "unknown error"}`.slice(0, 300);
}

const refuse = (status: number, code: Extract<EffectOutcome, { ok: false }>["code"], error: string): EffectOutcome => ({
  ok: false,
  status,
  code,
  error,
});
const invalid = (why: string) => refuse(400, "invalid", why);

const optionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

/** What the background half of a spawn needs to know. */
interface SpawnJob {
  commandId: string;
  threadId: string;
  paneId: string;
  /** The terminal herdr named at creation; "" when it named none. */
  terminalId: string;
  workspaceId: string;
  /** This command created the workspace (`newProject`). */
  workspaceCreated: boolean;
  kind: string;
  args: string[];
  agentName: string;
}

type Stage = "pane" | "prompt" | "agent";

// ── The spawner ──────────────────────────────────────────────────────────────────────────────────

export function createSpawner(deps: SpawnDeps): Spawner {
  const { store, herdr, engine, queue, journals } = deps;
  const audit = deps.audit ?? SILENT_AUDIT;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const resolveDir = deps.resolveDir ?? resolveLocalDir;
  const promptWaitMs = deps.promptWaitMs ?? PROMPT_WAIT_MS;
  const startTimeoutMs = deps.startTimeoutMs ?? AGENT_START_TIMEOUT_MS;
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const background = new Set<Promise<void>>();

  const track = (work: Promise<void>) => {
    const p = work.catch((err) => log(`[threads] spawn: ${(err as Error).message}`));
    background.add(p);
    void p.then(() => background.delete(p));
  };

  /** Agent names the herd already uses. */
  const takenNames = (): Set<string> =>
    new Set(engine.current().agents.flatMap((a) => (a.agentName ? [a.agentName] : [])));

  /** `<harness>-<n>`: n counts the project's live threads of that harness, then skips names in use. */
  const defaultName = (harness: string, projectId: string): string => {
    const live = store.listThreads().filter((t) => t.projectId === projectId && t.harness === harness && t.shelf !== "archived");
    const taken = takenNames();
    const base = agentNameFrom(harness, harness) || "agent";
    for (let n = live.length + 1; ; n++) {
      const name = suffixedName(base, n);
      if (!taken.has(name)) return name;
    }
  };

  const projectFrom = (created: CreatedShell, label: string | undefined): Project => {
    const existing = store.getProject(created.workspaceId);
    if (existing) return existing;
    const number = created.workspaceNumber ?? 0;
    return {
      id: created.workspaceId,
      label: created.workspaceLabel || label || created.workspaceId,
      labelSource: "herd",
      number,
      order: number,
      status: "idle",
    };
  };

  // ── project.create ──

  const projectCreate: EffectHandler = async (command, ctx) => {
    if (command.type !== "project.create") return invalid("wrong-type");
    const c = command as CommandOf<"project.create">;
    if (typeof c.cwd !== "string" || c.cwd.trim() === "") return invalid("bad-cwd");
    if (!optionalString(c.label) || (c.label !== undefined && (c.label.length > MAX_TITLE_LENGTH || hasControl(c.label)))) {
      return invalid("bad-label");
    }
    const cwd = await resolveDir(c.cwd.trim());
    if (!cwd) return invalid("bad-cwd");
    const label = c.label?.trim() || undefined;
    return queue.run(SPAWN_KEY, async () => {
      let created: CreatedShell;
      try {
        created = await herdr.createWorkspace({ cwd, ...(label ? { label } : {}) });
      } catch (err) {
        return refuse(502, "failed", failureText("create workspace", err));
      }
      audit.record({ action: "workspace.create", paneId: created.paneId, detail: { label, cwd, v2: true } });
      const { last } = store.append([{ type: "project.upserted", payload: { project: projectFrom(created, label) } }], {
        commandId: ctx.commandId,
        receipt: ctx.receipt,
      });
      return { ok: true, sequence: last };
    });
  };

  // ── thread.create ──

  const threadCreate: EffectHandler = async (command, ctx) => {
    if (command.type !== "thread.create") return invalid("wrong-type");
    const c = command as CommandOf<"thread.create">;

    // 1. Validate. Nothing touches herdr until the whole command is known to be good.
    if (typeof c.harness !== "string" || !launchFor(c.harness)) return invalid("invalid-launch: no-launch");
    if (!optionalString(c.model) || !optionalString(c.effort) || !optionalString(c.permissionMode)) {
      return invalid("invalid-launch: bad-type");
    }
    const built = buildLaunchArgs(c.harness, {
      ...(c.model !== undefined ? { model: c.model.trim() } : {}),
      ...(c.effort !== undefined ? { effort: c.effort } : {}),
      ...(c.permissionMode !== undefined ? { permissionMode: c.permissionMode } : {}),
    });
    if (!built.ok) return invalid(`invalid-launch: ${built.reason}`);
    if (built.destructive && c.confirmBypass !== true) return invalid("bypass-needs-confirm");
    if (c.name !== undefined && (typeof c.name !== "string" || c.name.trim() === "" || c.name.length > MAX_NAME_LENGTH || hasControl(c.name))) {
      return invalid("bad-name");
    }
    if (c.direction !== undefined && c.direction !== "right" && c.direction !== "down") return invalid("bad-direction");
    if (c.projectId !== undefined && c.newProject !== undefined) return invalid("projectId-and-newProject");

    let newProject: { cwd: string; label?: string } | null = null;
    let from: ServerThread | null = null;
    let projectId: string;
    if (c.newProject !== undefined) {
      const np = c.newProject as unknown;
      if (typeof np !== "object" || np === null) return invalid("bad-newProject");
      const { cwd, label } = np as { cwd?: unknown; label?: unknown };
      if (typeof cwd !== "string" || cwd.trim() === "") return invalid("bad-cwd");
      if (!optionalString(label) || (label !== undefined && (label.length > MAX_TITLE_LENGTH || hasControl(label)))) {
        return invalid("bad-label");
      }
      const dir = await resolveDir(cwd.trim());
      if (!dir) return invalid("bad-cwd");
      newProject = { cwd: dir, ...(label?.trim() ? { label: label.trim() } : {}) };
      projectId = "";
    } else {
      if (c.placement !== "tab" && c.placement !== "split") return invalid("bad-placement");
      if (c.placement === "split") {
        if (typeof c.splitFrom !== "string" || c.splitFrom === "") return invalid("bad-splitFrom");
        from = store.getThread(c.splitFrom);
        if (!from) return refuse(404, "not_found", "no-such-thread");
        if (from.shelf === "archived") return refuse(409, "conflict", "thread-archived");
        if (c.projectId !== undefined && c.projectId !== from.projectId) return invalid("splitFrom-not-in-project");
        const alive = [...engine.current().agents, ...engine.current().shellPanes].some((p) => p.paneId === from!.paneId);
        if (!alive) return refuse(409, "conflict", "pane-gone");
        projectId = from.projectId;
      } else {
        if (typeof c.projectId !== "string" || c.projectId === "") return invalid("bad-projectId");
        projectId = c.projectId;
      }
      const project = store.getProject(projectId);
      if (!project || project.closedAt !== undefined) return refuse(404, "not_found", "no-such-project");
    }

    const harness = c.harness;
    const launch = launchFor(harness)!;
    const given = c.name?.trim();

    // 2–4. Make the pane and announce the thread, one spawn at a time.
    return queue.run(SPAWN_KEY, async (): Promise<EffectOutcome> => {
      const display = given ?? (newProject ? `${agentNameFrom(harness, harness) || "agent"}-1` : defaultName(harness, projectId));
      let created: CreatedShell;
      try {
        if (newProject) created = await herdr.createWorkspace(newProject);
        else if (from) created = await herdr.splitPane({ targetPaneId: from.paneId, direction: c.direction ?? "right" });
        else created = await herdr.createTab(projectId, { label: display });
      } catch (err) {
        // Nothing exists yet, so there is no thread to fail: the command itself fails, with no receipt.
        return refuse(502, "failed", failureText("spawn-failed: create pane", err));
      }
      const pid = created.workspaceId;
      const at = store.now();
      const capabilities = capabilitiesFor(harness, journals);
      const model = c.model?.trim() || undefined;
      const fields = {
        title: display.slice(0, MAX_TITLE_LENGTH),
        titleSource: given ? ("user" as const) : ("herd" as const),
        harness,
        status: "starting" as const,
        capabilities,
        ...(model ? { model } : {}),
        ...(c.permissionMode ? { permissionMode: c.permissionMode } : {}),
      };

      const events: EventDraft[] = [];
      if (newProject) events.push({ type: "project.upserted", payload: { project: projectFrom(created, newProject.label) } });
      // The herd ingest may have listed the pane already (its poll raced the reply): take that thread over.
      const seen = store
        .listThreads()
        .find(
          (t) =>
            t.paneId === created.paneId &&
            t.shelf !== "archived" &&
            (t.terminalId === "" || !created.terminalId || t.terminalId === created.terminalId),
        );
      let threadId: string;
      if (seen) {
        threadId = seen.id;
        const patch: ServerThreadPatch = { ...fields, ...(created.terminalId && !seen.terminalId ? { terminalId: created.terminalId } : {}) };
        events.push({ type: "thread.updated", threadId, payload: { patch, at } });
      } else {
        threadId = store.newId();
        const thread: ServerThread = {
          id: threadId,
          paneId: created.paneId,
          terminalId: created.terminalId ?? "",
          projectId: pid,
          shelf: "active",
          unreadDone: false,
          lastActivityAt: at,
          createdAt: at,
          updatedAt: at,
          ...fields,
        };
        events.push({ type: "thread.created", threadId, payload: { thread } });
      }
      const { last } = store.append(events, { commandId: ctx.commandId, receipt: ctx.receipt });
      audit.record({
        action: "thread.create",
        paneId: created.paneId,
        detail: { harness, placement: newProject ? "workspace" : (c.placement ?? "tab"), args: built.args },
      });

      const agentName = (given ? agentNameFrom(given, harness) : "") || agentNameFrom(display, harness) || defaultName(harness, pid);
      track(
        finish({
          commandId: ctx.commandId,
          threadId,
          paneId: created.paneId,
          terminalId: created.terminalId ?? "",
          workspaceId: pid,
          workspaceCreated: newProject !== null,
          kind: launch.kind,
          args: built.args,
          agentName,
        }),
      );
      return { ok: true, sequence: last, threadId };
    });
  };

  // ── The background half ──

  const append = (job: SpawnJob, events: EventDraft[]) => {
    if (events.length > 0) store.append(events, { commandId: job.commandId });
  };

  /** 5. The new shell's prompt: the last non-blank line is there and the same on two reads in a row. */
  const waitForPrompt = async (paneId: string): Promise<boolean> => {
    const deadline = store.now() + promptWaitMs;
    let previous: string | null = null;
    for (;;) {
      try {
        // `visible`, not `recent`: a fresh shell's prompt is on screen, and a visible read never scrolls a pane.
        const line = lastLine((await herdr.readPane(paneId, "visible", 20)).text);
        if (line !== "" && line === previous) return true;
        previous = line;
      } catch (err) {
        if (herdrErrorCode(err) === "pane_not_found") return false;
      }
      if (store.now() >= deadline) return false;
      await sleep(PROMPT_POLL_MS);
    }
  };

  /** Ours to close: still there, still the terminal we made, and no agent in it. */
  const safeToClose = async (job: SpawnJob): Promise<"gone" | "yes" | "no"> => {
    try {
      const pane = await herdr.getPane(job.paneId);
      if (!pane) return "gone";
      return job.terminalId !== "" && pane.terminalId === job.terminalId && pane.agent === null ? "yes" : "no";
    } catch {
      return "no";
    }
  };

  /** Close what this command made, as far as it is still safely ours. True when the pane is gone afterwards. */
  const cleanUp = async (job: SpawnJob): Promise<boolean> => {
    const safe = await safeToClose(job);
    if (safe === "gone") return true;
    if (safe === "no") return false;
    try {
      if (job.workspaceCreated) {
        const ws = (await herdr.listWorkspaces()).find((w) => w.workspace_id === job.workspaceId);
        if (ws && ws.pane_count === 1 && ws.tab_count === 1) {
          await herdr.closeWorkspace(job.workspaceId);
          audit.record({ action: "workspace.close", paneId: job.paneId, detail: { workspaceId: job.workspaceId, reason: "spawn-failed" } });
          return true;
        }
      }
      await herdr.closePane(job.paneId);
      audit.record({ action: "pane.close", paneId: job.paneId, detail: { reason: "spawn-failed" } });
      return true;
    } catch (err) {
      log(`[threads] spawn clean-up failed: ${(err as Error).message}`);
      return false;
    }
  };

  const notice = (job: SpawnJob, message: string): EventDraft => {
    const at = store.now();
    return {
      type: "turn-item.updated",
      threadId: job.threadId,
      payload: {
        item: {
          id: `spawn:${job.threadId}`,
          threadId: job.threadId,
          runId: null,
          status: "failed",
          title: null,
          startedAt: null,
          completedAt: at,
          createdAt: at,
          updatedAt: at,
          type: "system_notice",
          message,
        },
      },
    };
  };

  /** 8. A hard failure: say so, close what is safely ours, and archive the thread if its pane is gone. */
  const fail = async (job: SpawnJob, stage: Stage, message: string): Promise<void> => {
    const closed = await cleanUp(job);
    const thread = store.getThread(job.threadId);
    const events: EventDraft[] = [{ type: "thread.create.failed", threadId: job.threadId, payload: { threadId: job.threadId, stage, message } }];
    if (thread) {
      events.push(notice(job, message));
      if (thread.shelf !== "archived") {
        if (closed) {
          events.push({ type: "thread.archived", threadId: job.threadId, payload: { reason: "spawn-failed", at: store.now() } });
        } else if (thread.status === "starting") {
          // The pane stays (someone else may be using it): hand the thread back to the herd ingest.
          events.push({ type: "thread.updated", threadId: job.threadId, payload: { patch: { status: "idle" }, at: store.now() } });
        }
      }
    }
    append(job, events);
  };

  /** 7. The engine's snapshot shows the agent (the herd ingest has then updated the thread), or the wait ran out. */
  const waitForAgent = (paneId: string): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      let off: (() => void) | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        off?.();
        resolve();
      };
      off = engine.onUpdate((snap) => {
        if (snap.agents.some((a) => a.paneId === paneId)) finish();
      });
      engine.pokeNow();
      void sleep(settleMs).then(finish);
    });

  const finish = async (job: SpawnJob): Promise<void> => {
    if (!(await waitForPrompt(job.paneId))) {
      await fail(job, "prompt", `The shell prompt did not appear in ${Math.round(promptWaitMs / 1000)} s`);
      return;
    }
    let name = job.agentName;
    let busy = 0;
    let renamed = 0;
    for (;;) {
      // Archived meanwhile (the operator gave up on it): start nothing.
      if (store.getThread(job.threadId)?.shelf === "archived") return;
      try {
        await herdr.startAgent({ paneId: job.paneId, name, kind: job.kind, args: job.args, timeoutMs: startTimeoutMs });
        break;
      } catch (err) {
        const code = herdrErrorCode(err);
        const text = err instanceof Error ? err.message : String(err);
        if ((code === "agent_pane_busy" || /not an available shell|not at .*prompt/i.test(text)) && busy < BUSY_RETRIES) {
          busy++;
          await sleep(BUSY_RETRY_MS);
          continue;
        }
        if (code === "agent_name_taken" && renamed < NAME_RETRIES) {
          renamed++;
          name = suffixedName(job.agentName, renamed + 1);
          continue;
        }
        if (code === "timeout") {
          // 9. A slow cold start is common: the pane stays and the thread stays `starting` until the herd
          // ingest sees the agent or the operator archives it.
          const message = `The agent did not start in ${Math.round(startTimeoutMs / 1000)} s`;
          append(job, [
            { type: "thread.create.failed", threadId: job.threadId, payload: { threadId: job.threadId, stage: "agent", message } },
            notice(job, message),
          ]);
          return;
        }
        log(`[threads] spawn: agent.start in ${job.paneId} failed: ${text}`);
        await fail(job, "agent", startFailureText(err));
        return;
      }
    }
    await waitForAgent(job.paneId);
    const thread = store.getThread(job.threadId);
    if (thread && thread.shelf !== "archived" && thread.status === "starting") {
      append(job, [{ type: "thread.updated", threadId: job.threadId, payload: { patch: { status: "idle" }, at: store.now() } }]);
    }
  };

  return {
    effects: { "thread.create": threadCreate, "project.create": projectCreate },
    async settled() {
      while (background.size > 0) await Promise.all([...background]);
    },
  };
}
