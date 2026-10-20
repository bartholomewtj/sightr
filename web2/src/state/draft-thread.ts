/**
 * The new-thread draft (T14): one draft at a time, kept in localStorage (try/catch) so a reload keeps
 * it, cleared on a successful start or Discard. T3 keeps its drafts in `composerDraftStore`; Sightr's
 * draft is smaller because the pickers are launch arguments, not provider sessions.
 *
 * Nothing goes to the bridge until Start. Start posts one `thread.create` built from the draft's ids
 * (the bridge builds the CLI arguments). The progress that follows is bound to that command's id: its
 * `thread.created` event names the thread, and from then on the thread's own status in the shell store
 * decides the phase, so a reload rebuilds the same view. The first message is not part of
 * `thread.create`: once the thread exists, its attachments upload to the new pane and one
 * `message.dispatch {mode: "queue"}` goes to T06, which holds it until the agent settles.
 */
import { create } from "zustand";

import type { ChatAttachment, Thread, ThreadEvent } from "@shared/v2/contracts";
import {
  commandPreview,
  createPayload,
  isDestructiveMode,
  nameFromMessage,
  phaseForThread,
  splitSource,
  startRefusalText,
  tileFor,
  type SpawnPhase,
} from "@/components/new-thread/NewThread.logic";
import { cleanDefaults, defaultsFor, type HarnessDefaults } from "@/components/new-thread/ThreadDefaults.logic";
import { uploadImage } from "@/lib/api";
import { refusalText } from "@/state/composer";
import { getThreadDefaults } from "@/state/thread-defaults";
import { defaultCommandDeps, sendCommand, V2CommandError, type CommandDeps } from "@/stream/commands";
import { onShellEvent } from "@/stream/shell-events";
import { useShell } from "@/stream/stores";

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────

export interface DraftThread {
  projectId: string | null;
  harness: string | null;
  /** "" everywhere below means "not chosen": no argument, the harness's own default. */
  model: string;
  effort: string;
  permissionMode: string;
  placement: "tab" | "split";
  direction: "right" | "down";
  /** The tab name; "" is T07's default name. */
  name: string;
  /** The operator typed the name, so the first message no longer fills it. */
  nameEdited: boolean;
  text: string;
}

export type FirstMessageState = "none" | "pending" | "sent" | "failed";

export interface DraftStart {
  /** The `thread.create` command; a network retry reuses it. */
  commandId: string;
  /** The first message's `message.dispatch` id, fixed up front so a resend after a reload is one send. */
  dispatchCommandId: string;
  threadId: string | null;
  phase: SpawnPhase;
  startedAt: number;
  harnessLabel: string;
  /** The command shown to the operator (display only). */
  commandLine: string | null;
  /** Null when there is no first message. */
  firstMessage: string | null;
  messageState: FirstMessageState;
  messageError: string | null;
  failure: { message: string; stage?: string } | null;
}

export interface NewProjectForm {
  open: boolean;
  label: string;
  cwd: string;
  /** The `project.create` in flight ("Creating…"). */
  commandId: string | null;
  error: string | null;
}

interface DraftStore {
  draft: DraftThread;
  start: DraftStart | null;
  form: NewProjectForm;
  /** Files picked for the first message. Memory only: a File cannot be stored, so a reload drops them. */
  attachments: File[];
  /** A destructive mode tapped once: its warning shows and a second tap selects it. */
  bypassArmed: string | null;
  /** Start was tapped once with a destructive mode: the next tap starts it (the second confirmation). */
  startConfirm: boolean;
  /** A `thread.create` is being posted: a second tap posts nothing. */
  posting: boolean;
  /** The last thread the operator had open (the split source). */
  openThreadId: string | null;
  /** Mounted draft screens; with none, a ready start finishes on its own. */
  screens: number;
}

export const EMPTY_DRAFT: DraftThread = {
  projectId: null,
  harness: null,
  model: "",
  effort: "",
  permissionMode: "",
  placement: "tab",
  direction: "right",
  name: "",
  nameEdited: false,
  text: "",
};

const CLOSED_FORM: NewProjectForm = { open: false, label: "", cwd: "", commandId: null, error: null };

// ── Storage ─────────────────────────────────────────────────────────────────────────────────────

export const DRAFT_KEY = "sightr:v2:new-thread:draft";
export const LAST_KEY = "sightr:v2:new-thread:last";
/** The project the last start went to. */
export const LAST_PROJECT_KEY = "sightr:v2:new-thread:last-project";

function readJson(key: string): unknown {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or full: the draft lasts this page only
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function loadSaved(): { draft: DraftThread; start: DraftStart | null } {
  const saved = readJson(DRAFT_KEY);
  if (!isObj(saved) || !isObj(saved.draft)) return { draft: EMPTY_DRAFT, start: null };
  const draft = { ...EMPTY_DRAFT, ...(saved.draft as Partial<DraftThread>) };
  let start = isObj(saved.start) && typeof saved.start.commandId === "string" ? (saved.start as unknown as DraftStart) : null;
  // A send in flight when the page went away never finishes, and nothing retries a "pending" start: it
  // would spin on "Queuing the first message…" for ever. Show it as failed so it can be retried or left.
  // (The attachments are File objects and do not survive a reload either.)
  if (start && start.messageState === "pending") {
    start = { ...start, messageState: "failed", messageError: "the page reloaded before it was sent" };
  }
  return { draft, start };
}

interface LastUsed {
  /** The harness's launch-table id. */
  tile: string;
  permissionMode: string;
  /** Absent in an entry saved before models were remembered: the harness default stands in. */
  model?: string;
  effort?: string;
}

function lastUsed(projectId: string): LastUsed | null {
  const all = readJson(LAST_KEY);
  const entry = isObj(all) ? all[projectId] : null;
  if (!isObj(entry)) return null;
  const { harness: tile, permissionMode: mode, model, effort } = entry;
  if (typeof tile !== "string") return null;
  return {
    tile,
    permissionMode: typeof mode === "string" ? mode : "",
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof effort === "string" ? { effort } : {}),
  };
}

/**
 * The model, effort and mode a draft opens with for a harness: what this project used last time with it,
 * else the operator's default for the harness (Settings → New threads), else nothing chosen. Every value
 * is checked against the launch table, and a bypass mode is never brought back: it is chosen fresh, with
 * its two confirmations, every time.
 */
export function seedPickers(projectId: string | null, id: string): HarnessDefaults {
  const defaults = defaultsFor(getThreadDefaults(), id);
  const last = projectId ? lastUsed(projectId) : null;
  if (!last || last.tile !== id) return defaults;
  return cleanDefaults(id, {
    model: last.model ?? defaults.model,
    effort: last.effort ?? defaults.effort,
    permissionMode: last.permissionMode,
  });
}

function rememberLastUsed(projectId: string, used: LastUsed): void {
  const all = readJson(LAST_KEY);
  const { tile, ...rest } = used;
  writeJson(LAST_KEY, { ...(isObj(all) ? all : {}), [projectId]: { harness: tile, ...rest } });
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

function initialState(): DraftStore {
  const { draft, start } = loadSaved();
  return {
    draft,
    start,
    form: CLOSED_FORM,
    attachments: [],
    bypassArmed: null,
    startConfirm: false,
    posting: false,
    openThreadId: null,
    screens: 0,
  };
}

export const useDraftThread = create<DraftStore>(initialState);

let persisting = true;
useDraftThread.subscribe((s, prev) => {
  if (!persisting || (s.draft === prev.draft && s.start === prev.start)) return;
  const empty = s.start === null && JSON.stringify(s.draft) === JSON.stringify(EMPTY_DRAFT);
  writeJson(DRAFT_KEY, empty ? null : { draft: s.draft, start: s.start });
});

const get = () => useDraftThread.getState();
const set = (patch: Partial<DraftStore>) => useDraftThread.setState(patch);
const patchDraft = (patch: Partial<DraftThread>) => set({ draft: { ...get().draft, ...patch } });
const patchStart = (patch: Partial<DraftStart>) => {
  const start = get().start;
  if (start) set({ start: { ...start, ...patch } });
};

// ── Seams ───────────────────────────────────────────────────────────────────────────────────────

let commandDeps: () => CommandDeps = defaultCommandDeps;
let upload: typeof uploadImage = uploadImage;
let now: () => number = () => Date.now();

/** Test seam: the command client, the uploader and the clock. */
export function __setDraftDeps(deps: { command?: () => CommandDeps; upload?: typeof uploadImage; now?: () => number }): void {
  if (deps.command) commandDeps = deps.command;
  if (deps.upload) upload = deps.upload;
  if (deps.now) now = deps.now;
}

const withId = (commandId: string): CommandDeps => ({ ...commandDeps(), newId: () => commandId });

// ── Draft edits ─────────────────────────────────────────────────────────────────────────────────

/**
 * Choose the project. A project newly chosen brings back the harness, model, effort and mode last used in
 * it here; with no history, a draft that has no harness yet opens on the default harness, if one is set.
 */
export function selectDraftProject(projectId: string): void {
  const { draft } = get();
  if (draft.projectId === projectId) return;
  const last = lastUsed(projectId);
  if (last && tileFor(last.tile)) {
    set({ draft: { ...draft, projectId, harness: last.tile, ...seedPickers(projectId, last.tile) }, bypassArmed: null, startConfirm: false });
    return;
  }
  set({ draft: withDefaultHarness({ ...draft, projectId }), bypassArmed: null, startConfirm: false });
}

/**
 * The project a draft with none chosen opens on, so the top "New thread" button is not a dead end: the
 * project of the thread open beside it, else the one the last start went to, else the only one there is.
 * Null when there is no sensible answer (several projects and no history): the operator chooses.
 */
export function defaultDraftProject(): string | null {
  const { projects, threads } = useShell.getState();
  const open = (id: string | null | undefined): id is string => !!id && projects[id] !== undefined && projects[id]!.closedAt === undefined;
  const openThread = get().openThreadId;
  const fromThread = openThread ? threads[openThread]?.projectId : null;
  if (open(fromThread)) return fromThread;
  const last = readJson(LAST_PROJECT_KEY);
  if (open(typeof last === "string" ? last : null)) return last as string;
  const all = Object.values(projects).filter((p) => p.closedAt === undefined);
  return all.length === 1 ? all[0]!.id : null;
}

/** A draft with no harness yet takes the operator's default harness and its default pickers. */
function withDefaultHarness(draft: DraftThread): DraftThread {
  const wanted = getThreadDefaults().harness;
  if (draft.harness || !wanted || !tileFor(wanted)) return draft;
  return { ...draft, harness: wanted, ...seedPickers(draft.projectId, wanted) };
}

/** Choose the harness. The pickers reset to what this project last used with it, else the defaults. */
export function setDraftHarness(id: string): void {
  const { draft } = get();
  const current = draft.harness;
  if (current === id) return;
  set({
    draft: { ...draft, harness: id, ...seedPickers(draft.projectId, id) },
    bypassArmed: null,
    startConfirm: false,
  });
}

export function setDraftModel(model: string): void {
  patchDraft({ model });
}

export function setDraftEffort(effort: string): void {
  patchDraft({ effort });
}

/**
 * Choose a permission mode. A destructive one (it skips approvals) needs a second tap: the first shows
 * its warning. "" goes back to the harness default.
 */
export function pickDraftMode(modeId: string): "selected" | "armed" {
  const { draft, bypassArmed } = get();
  if (modeId !== "" && isDestructiveMode(draft.harness, modeId) && bypassArmed !== modeId) {
    set({ bypassArmed: modeId, startConfirm: false });
    return "armed";
  }
  set({ draft: { ...draft, permissionMode: modeId }, bypassArmed: null, startConfirm: false });
  return "selected";
}

export function setDraftPlacement(placement: "tab" | "split"): void {
  patchDraft({ placement });
}

export function setDraftDirection(direction: "right" | "down"): void {
  patchDraft({ direction });
}

export function setDraftName(name: string): void {
  patchDraft({ name, nameEdited: name !== "" });
}

/** The first message. Until the operator names the tab, its first words name it. */
export function setDraftText(text: string): void {
  const { draft } = get();
  patchDraft({ text, ...(draft.nameEdited ? {} : { name: nameFromMessage(text) }) });
}

export function addDraftAttachments(files: readonly File[]): void {
  set({ attachments: [...get().attachments, ...files] });
}

export function removeDraftAttachment(index: number): void {
  set({ attachments: get().attachments.filter((_, i) => i !== index) });
}

export function discardDraft(): void {
  set({ draft: EMPTY_DRAFT, start: null, attachments: [], form: CLOSED_FORM, bypassArmed: null, startConfirm: false, posting: false });
}

/** The thread route reports what is open, so the draft can offer a split next to it. */
export function noteOpenThread(threadId: string): void {
  if (get().openThreadId !== threadId) set({ openThreadId: threadId });
}

// ── New project ─────────────────────────────────────────────────────────────────────────────────

export function openNewProjectForm(): void {
  set({ form: { ...CLOSED_FORM, open: true } });
}

export function closeNewProjectForm(): void {
  if (get().form.commandId) return;
  set({ form: CLOSED_FORM });
}

export function setNewProjectField(field: "label" | "cwd", value: string): void {
  set({ form: { ...get().form, [field]: value, error: null } });
}

/** `project.create`; the new project is selected when its `project.upserted` (same commandId) arrives. */
export async function createDraftProject(): Promise<void> {
  const { form } = get();
  if (form.commandId) return;
  const cwd = form.cwd.trim();
  if (!cwd) {
    set({ form: { ...form, error: "Give the folder path on the host." } });
    return;
  }
  const label = form.label.trim();
  const commandId = commandDeps().newId();
  const before = new Set(Object.keys(useShell.getState().projects));
  ensureListening();
  set({ form: { ...form, commandId, error: null } });
  try {
    await sendCommand("project.create", { cwd, ...(label ? { label } : {}) }, withId(commandId));
  } catch (err) {
    const why = err instanceof V2CommandError ? err.body?.error : undefined;
    if (get().form.commandId === commandId) {
      set({ form: { ...get().form, commandId: null, error: startRefusalText(why, refusalText(err)) } });
    }
    return;
  }
  // The event may have come already, or the stream may have replaced it with a snapshot: then the one
  // project that was not there before is ours.
  if (get().form.commandId !== commandId) return;
  const added = Object.keys(useShell.getState().projects).filter((id) => !before.has(id));
  if (added.length === 1) projectCreated(added[0]!);
}

function projectCreated(projectId: string): void {
  set({ form: CLOSED_FORM });
  const { draft } = get();
  set({ draft: withDefaultHarness({ ...draft, projectId }), startConfirm: false });
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────

export type StartResult = "started" | "confirm" | "invalid" | "busy";

/** The thread a split would open next to, if the draft's project holds the open thread. */
export function currentSplitSource(): Thread | null {
  const { openThreadId, draft } = get();
  const thread = openThreadId ? useShell.getState().threads[openThreadId] : null;
  return splitSource(thread, draft.projectId);
}

/** Can this harness take a first message (it drains a queue)? A plain shell cannot. */
export function takesFirstMessage(harness: string | null): boolean {
  const tile = tileFor(harness);
  return tile !== null && !tile.plainShell;
}

/**
 * Tap Start. A destructive mode asks once more first ("confirm"). One `thread.create` per tap; a tap
 * while one is posting or running does nothing.
 */
export async function startDraft(): Promise<StartResult> {
  const s = get();
  if (s.posting || (s.start && s.start.phase !== "failed")) return "busy";
  const { draft } = s;
  const destructive = isDestructiveMode(draft.harness, draft.permissionMode);
  if (destructive && !s.startConfirm) {
    set({ startConfirm: true });
    return "confirm";
  }
  const built = createPayload(draft, currentSplitSource(), destructive && s.startConfirm);
  if (!built.ok) return "invalid";
  const tile = tileFor(draft.harness)!;
  const text = takesFirstMessage(draft.harness) ? draft.text.trim() : "";
  const deps = commandDeps();
  const commandId = deps.newId();
  const start: DraftStart = {
    commandId,
    dispatchCommandId: deps.newId(),
    threadId: null,
    phase: "creating",
    startedAt: now(),
    harnessLabel: tile.label,
    commandLine: commandPreview(draft),
    firstMessage: text || null,
    messageState: text ? "none" : "sent",
    messageError: null,
    failure: null,
  };
  ensureListening();
  set({ start, posting: true, startConfirm: false });
  writeJson(LAST_PROJECT_KEY, built.payload.projectId);
  rememberLastUsed(built.payload.projectId!, {
    tile: tile.id,
    permissionMode: destructive ? "" : draft.permissionMode,
    model: draft.model.trim(),
    effort: draft.effort,
  });
  try {
    await sendCommand("thread.create", built.payload, withId(commandId));
  } catch (err) {
    if (get().start?.commandId === commandId) {
      const why = err instanceof V2CommandError ? err.body?.error : undefined;
      patchStart({ phase: "failed", failure: { message: startRefusalText(why, refusalText(err)) } });
    }
    set({ posting: false });
    return "started";
  }
  set({ posting: false });
  advance();
  return "started";
}

/** "Edit and try again": back to the draft with everything kept. The next Start is a new command. */
export function editAndRetry(): void {
  set({ start: null, startConfirm: false, posting: false });
}

/** The start reached Ready (and its first message is queued): the draft is done. */
export function finishStart(): void {
  set({ draft: EMPTY_DRAFT, start: null, attachments: [], bypassArmed: null, startConfirm: false, posting: false });
}

/** Re-send the first message after its upload or dispatch failed. */
export function retryFirstMessage(): void {
  patchStart({ messageState: "none", messageError: null });
  advance();
}

/** Retry the first message without the attachments that were refused. */
export function retryWithoutAttachments(): void {
  set({ attachments: [] });
  retryFirstMessage();
}

/** Draft screens mounted; with none, a ready start finishes by itself (the thread is in the sidebar). */
export function mountDraftScreen(): () => void {
  set({ screens: get().screens + 1 });
  advance();
  return () => {
    set({ screens: Math.max(0, get().screens - 1) });
    advance();
  };
}

/** True when the progress view should move on to the thread. */
export function readyToOpen(start: DraftStart | null): start is DraftStart & { threadId: string } {
  return start !== null && start.phase === "ready" && start.threadId !== null && start.messageState === "sent";
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────

let sending = false;

async function sendFirstMessage(thread: Thread): Promise<void> {
  const start = get().start;
  if (!start || !start.firstMessage || sending) return;
  sending = true;
  patchStart({ messageState: "pending", messageError: null });
  try {
    const attachments: ChatAttachment[] = [];
    for (const file of get().attachments) {
      const res = await upload(thread.paneId, file);
      if (!res.ok) throw new Error(`${file.name || "attachment"}: ${res.error}`);
      attachments.push({ path: res.path, name: file.name || "attachment" });
    }
    await sendCommand(
      "message.dispatch",
      { threadId: thread.id, text: start.firstMessage, mode: "queue", ...(attachments.length > 0 ? { attachments } : {}) },
      withId(start.dispatchCommandId),
    );
    if (get().start?.commandId === start.commandId) patchStart({ messageState: "sent" });
  } catch (err) {
    if (get().start?.commandId === start.commandId) patchStart({ messageState: "failed", messageError: refusalText(err) });
  } finally {
    sending = false;
  }
  advance();
}

/** Move the progress on from the thread's own state in the shell store. */
function advance(): void {
  const start = get().start;
  if (!start || !start.threadId) return;
  const thread = useShell.getState().threads[start.threadId];
  const phase = phaseForThread(thread);
  // A `thread.create.failed` already said it failed: the thread's later status does not undo that.
  if (phase && start.phase !== "failed" && phase !== start.phase) patchStart({ phase });
  const cur = get().start!;
  if (thread && cur.phase !== "failed" && cur.firstMessage && cur.messageState === "none") void sendFirstMessage(thread);
  if (get().screens === 0 && readyToOpen(get().start)) finishStart();
}

function onEvent(event: ThreadEvent): void {
  const { start, form } = get();
  if (event.type === "project.upserted" && form.commandId && event.commandId === form.commandId) {
    projectCreated(event.payload.project.id);
    return;
  }
  if (!start) return;
  const ours = event.commandId !== undefined && event.commandId === start.commandId;
  if (ours && start.threadId === null && (event.type === "thread.created" || event.type === "thread.updated")) {
    // `thread.updated`: the herd ingest listed the pane first and the spawn took that thread over (T07).
    const threadId = event.type === "thread.created" ? event.payload.thread.id : event.threadId;
    if (threadId) patchStart({ threadId, phase: "starting" });
  }
  if (event.type === "thread.create.failed" && (ours || event.payload.threadId === get().start?.threadId)) {
    patchStart({ phase: "failed", threadId: event.payload.threadId, failure: { message: event.payload.message, stage: event.payload.stage } });
  }
  advance();
}

let listening = false;

function ensureListening(): void {
  if (listening) return;
  listening = true;
  onShellEvent(onEvent);
  useShell.subscribe((s, prev) => {
    if (s.threads !== prev.threads) advance();
  });
}

// A start saved before a reload carries on from the shell snapshot.
if (useDraftThread.getState().start) ensureListening();

/** Test helper: the store back to empty and storage cleared. */
export function __resetDraftThread(): void {
  persisting = false;
  writeJson(DRAFT_KEY, null);
  writeJson(LAST_KEY, null);
  writeJson(LAST_PROJECT_KEY, null);
  useDraftThread.setState(initialState(), true);
  persisting = true;
  sending = false;
  commandDeps = defaultCommandDeps;
  upload = uploadImage;
  now = () => Date.now();
  ensureListening();
}
