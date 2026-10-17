// The new-thread draft's pure rules (T14). Pickers come from the launch table (T07) and the capability
// flags (T08) in shared/agents.ts; nothing here names a harness. The flow follows T3 Code's draft
// (apps/web/src/routes/_chat.new.tsx, components/chat/DraftHeroHeadline.tsx) in pattern only.
import {
  AGENTS,
  buildLaunchArgs,
  capabilitiesFor,
  launchFor,
  MODEL_PATTERN,
  type LaunchChoice,
  type LaunchMode,
  type LaunchOptions,
} from "@shared/agents";
import type { Command, Project, Thread, ThreadCapabilities } from "@shared/v2/contracts";

import { buildProjectTree, flattenProjectTree } from "@/components/Sidebar.logic";

// ── Harness tiles ───────────────────────────────────────────────────────────────────────────────

/** The bridge's harness name for a pane with no agent (T07 "Terminal only"). */
export const PLAIN_SHELL_ID = "shell";

export interface HarnessTile {
  id: string;
  label: string;
  /** "Terminal only": a shell pane, no agent, no pickers. */
  plainShell: boolean;
  /** Shown under the label when the harness has no journal (README "Ingest"). */
  note: string | null;
}

export const NO_JOURNAL_NOTE = "No transcript; opens on the CLI";

/** One tile per descriptor with a launch spec, in table order, then Terminal only. */
export function harnessTiles(agents: readonly { id: string; label: string; launch?: unknown }[] = AGENTS): HarnessTile[] {
  const tiles: HarnessTile[] = agents
    .filter((a) => a.launch !== undefined)
    .map((a) => ({
      id: a.id,
      label: a.label,
      plainShell: false,
      note: capabilitiesFor(a.id).hasJournal ? null : NO_JOURNAL_NOTE,
    }));
  tiles.push({ id: PLAIN_SHELL_ID, label: "Terminal only", plainShell: true, note: null });
  return tiles;
}

export function tileFor(id: string | null, tiles: readonly HarnessTile[] = harnessTiles()): HarnessTile | null {
  return id === null ? null : (tiles.find((t) => t.id === id) ?? null);
}

// ── Pickers ─────────────────────────────────────────────────────────────────────────────────────

export interface HarnessPickers {
  /** Suggestions; free text is allowed too. Null: the harness takes no model flag. */
  models: readonly LaunchChoice[] | null;
  efforts: readonly string[] | null;
  modes: readonly LaunchMode[] | null;
  /** Live switches (T08): "Can change after start" vs "Fixed at start". */
  live: { model: boolean; effort: boolean; mode: boolean };
}

const hasArg = (arg: readonly string[] | undefined) => arg !== undefined && arg.length > 0;

/** What the chosen harness offers. A picker with no options is null and is not rendered. */
export function pickersFor(harness: string | null): HarnessPickers {
  const launch = harness ? launchFor(harness) : undefined;
  const caps: ThreadCapabilities = capabilitiesFor(harness ?? "");
  return {
    models: launch && hasArg(launch.modelArg) ? (launch.models ?? []) : null,
    efforts: launch && hasArg(launch.effortArg) && launch.efforts && launch.efforts.length > 0 ? launch.efforts : null,
    modes: launch && hasArg(launch.modeArg) && launch.modes && launch.modes.length > 0 ? launch.modes : null,
    live: { model: caps.canSwitchModel, effort: caps.canSetEffortLive, mode: caps.canSwitchPermissionMode },
  };
}

export function changeLabel(live: boolean): string {
  return live ? "Can change after start" : "Fixed at start";
}

export function isDestructiveMode(harness: string | null, modeId: string): boolean {
  return pickersFor(harness).modes?.find((m) => m.id === modeId)?.destructive === true;
}

/** A free-text model the bridge would refuse; null when it is fine (or empty: the harness default). */
export function modelError(harness: string | null, model: string): string | null {
  const value = model.trim();
  if (value === "") return null;
  if (pickersFor(harness).models?.some((m) => m.id === value)) return null;
  return MODEL_PATTERN.test(value) ? null : "Letters, digits and . _ : / - only, starting with a letter or digit.";
}

// ── Command preview ─────────────────────────────────────────────────────────────────────────────

export interface DraftChoice {
  harness: string | null;
  model: string;
  effort: string;
  permissionMode: string;
}

export function launchOptions(d: DraftChoice): LaunchOptions {
  return {
    ...(d.model.trim() ? { model: d.model.trim() } : {}),
    ...(d.effort ? { effort: d.effort } : {}),
    ...(d.permissionMode ? { permissionMode: d.permissionMode } : {}),
  };
}

/**
 * The command the bridge will run, for display: herdr's kind plus `buildLaunchArgs`, the same function
 * the bridge builds the real argument array with. The client never sends this; it sends the ids.
 */
export function commandPreview(d: DraftChoice): string | null {
  const tile = tileFor(d.harness);
  if (!tile) return null;
  if (tile.plainShell) return "A shell, no agent";
  const launch = launchFor(tile.id);
  const built = buildLaunchArgs(tile.id, launchOptions(d));
  if (!launch || !built.ok) return null;
  return [launch.kind, ...built.args].join(" ");
}

// ── Projects ────────────────────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  project: Project;
  threadCount: number;
  /** A linked worktree, shown under its primary as in the sidebar. */
  nested: boolean;
}

/** Open projects in sidebar order (worktrees under their primary), with live thread counts. */
export function projectEntries(projects: Iterable<Project>, threads: Iterable<Thread>): ProjectEntry[] {
  return flattenProjectTree(buildProjectTree(projects, threads)).map((n) => ({
    project: n.project,
    threadCount: n.count,
    nested: n.nested,
  }));
}

export function searchProjects(entries: readonly ProjectEntry[], query: string): ProjectEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.project.label.toLowerCase().includes(q) || String(e.project.number) === q);
}

// ── Name ────────────────────────────────────────────────────────────────────────────────────────

/** The tab name prefilled from the first message: its first five words, at most 40 characters. */
export function nameFromMessage(text: string): string {
  const words = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 5).join(" ");
  return words.length > 40 ? words.slice(0, 40).trimEnd() : words;
}

// ── Placement ───────────────────────────────────────────────────────────────────────────────────

/** Split needs an open thread whose pane is in the chosen project. Null when split is not offered. */
export function splitSource(openThread: Thread | null | undefined, projectId: string | null): Thread | null {
  if (!openThread || !projectId) return null;
  if (openThread.shelf === "archived" || openThread.projectId !== projectId) return null;
  return openThread;
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

export interface DraftForCommand extends DraftChoice {
  projectId: string | null;
  placement: "tab" | "split";
  direction: "right" | "down";
  name: string;
}

export type CreatePayload = Omit<Extract<Command, { type: "thread.create" }>, "commandId" | "type">;

/** `thread.create` from the draft's ids, or the reason it cannot start yet. */
export function createPayload(
  d: DraftForCommand,
  split: Thread | null,
  confirmBypass: boolean,
): { ok: true; payload: CreatePayload } | { ok: false; reason: string } {
  if (!d.projectId) return { ok: false, reason: "Pick a project." };
  const tile = tileFor(d.harness);
  if (!tile) return { ok: false, reason: "Pick what to start." };
  const name = d.name.trim();
  const base = {
    projectId: d.projectId,
    harness: tile.id,
    ...(name ? { name } : {}),
    ...(d.placement === "split" && split
      ? { placement: "split" as const, splitFrom: split.id, direction: d.direction }
      : { placement: "tab" as const }),
  };
  if (tile.plainShell) return { ok: true, payload: base };
  if (modelError(tile.id, d.model)) return { ok: false, reason: "Check the model id." };
  const opts = launchOptions(d);
  const built = buildLaunchArgs(tile.id, opts);
  if (!built.ok) return { ok: false, reason: "That choice is not in the launch table." };
  if (built.destructive && !confirmBypass) return { ok: false, reason: "Confirm the bypass mode." };
  return { ok: true, payload: { ...base, ...opts, ...(built.destructive ? { confirmBypass: true } : {}) } };
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────

export type SpawnPhase = "creating" | "starting" | "ready" | "failed";

/** A start that has not reached Ready after this long shows "Still starting…". */
export const STILL_STARTING_MS = 45_000;
/** Ready → the thread route after this long. */
export const READY_NAV_MS = 400;

/** The phase a thread's own state says (shell snapshot or events). Null: the thread is not known yet. */
export function phaseForThread(thread: Thread | null | undefined): SpawnPhase | null {
  if (!thread) return null;
  if (thread.shelf === "archived") return thread.archiveReason === "spawn-failed" ? "failed" : "ready";
  if (thread.status === "starting") return "starting";
  if (thread.status === "failed") return "failed";
  return "ready";
}

/** The operator's words for a `thread.create` refusal (T07's codes). */
export function startRefusalText(error: string | undefined, fallback: string): string {
  const why = error ?? "";
  if (why === "bad-cwd") return "That folder does not exist on the host.";
  if (why === "no-such-project") return "That project is gone.";
  if (why === "pane-gone") return "The pane to split is gone.";
  if (why === "bypass-needs-confirm") return "The bridge needs the bypass confirmed.";
  if (why.startsWith("invalid-launch")) return `The bridge refused the launch choice (${why.replace(/^invalid-launch:\s*/, "")}).`;
  if (why.startsWith("spawn-failed")) return why.replace(/^spawn-failed:\s*/, "herdr refused: ");
  return why || fallback;
}
