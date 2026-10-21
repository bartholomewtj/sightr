/**
 * The composer's state (T12), beside the thread store it reads from.
 *
 * - **Per-device settings** in localStorage: what Enter does, and what a send while the agent works
 *   does (Queue or Steer). Phone and desktop get different Enter defaults.
 * - **Per-thread composer state** in memory: a command in flight, the queued message being edited,
 *   attachment chips, the error banner, "Answered elsewhere", the request option in flight.
 * - **The commands** the composer posts. The bridge does the work (T06); nothing here types into a
 *   pane. A send clears the draft only on the bridge's `{ sequence }` reply; a refusal keeps it.
 */
import { create } from "zustand";

import type { ChatAttachment, DispatchMode, QueuedMessage } from "@shared/v2/contracts";
import { showToast } from "@/components/toast";
import { dismissThreadUndoNotice, showThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { uploadImage } from "@/lib/api";
import { clearDraft, loadDraft } from "@/lib/drafts";
import { consumeSent } from "@/state/lineComments";
import { followTimeline } from "@/state/timeline";
import { defaultCommandDeps, sendCommand, V2CommandError, type CommandDeps, type CommandPayload } from "@/stream/commands";
import { useThreadStore } from "@/stream/stores";

// ── Settings (per device) ───────────────────────────────────────────────────────────────────────

/** `enter`: Enter sends, Shift+Enter adds a line. `mod-enter`: Mod+Enter sends, Enter adds a line. */
export type EnterMode = "enter" | "mod-enter";
/** What a send does while the agent works (T3's `activeTurnDefault`). */
export type FollowUp = "queue" | "steer";

const ENTER_KEY = "sightr:v2:composer:enter";
const FOLLOW_KEY = "sightr:v2:composer:follow-up";

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the setting lasts this page only
  }
}

interface ComposerSettings {
  /** null: the device default (desktop Enter sends, phone Enter adds a line). */
  enterMode: EnterMode | null;
  followUp: FollowUp;
}

function initialSettings(): ComposerSettings {
  const enter = read(ENTER_KEY);
  const follow = read(FOLLOW_KEY);
  return {
    enterMode: enter === "enter" || enter === "mod-enter" ? enter : null,
    followUp: follow === "steer" ? "steer" : "queue",
  };
}

export const useComposerSettings = create<ComposerSettings>(initialSettings);

export function setEnterMode(mode: EnterMode): void {
  write(ENTER_KEY, mode);
  useComposerSettings.setState({ enterMode: mode });
}

export function setFollowUp(followUp: FollowUp): void {
  write(FOLLOW_KEY, followUp);
  useComposerSettings.setState({ followUp });
}

/**
 * The Enter mode in force: the stored one, else the device default. A touch screen defaults to
 * `mod-enter` even at a desktop-wide layout (a tablet); same rule as the composer's `enterModeFor`.
 */
export function resolveEnterMode(stored: EnterMode | null, layout: "desktop" | "phone"): EnterMode {
  if (stored) return stored;
  const coarse = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return layout === "desktop" && !coarse ? "enter" : "mod-enter";
}

// ── Per-thread state ────────────────────────────────────────────────────────────────────────────

export type AttachmentStatus = "uploading" | "done" | "failed";

export interface AttachmentChip {
  id: string;
  name: string;
  status: AttachmentStatus;
  /** Where the agent can read it, once uploaded. */
  path?: string;
  error?: string;
  /** The staged file is an image: the chip shows a thumbnail and opens the viewer. */
  image?: boolean;
}

export interface ComposerError {
  text: string;
  /** Present when a Retry may re-send: the text never reached the pane. */
  retry?: { text: string; attachments: ChatAttachment[] };
}

export interface EditingQueued {
  id: string;
  originalText: string;
  /** The box's own draft, put back when the edit ends. */
  savedDraft: string;
}

export interface ThreadComposer {
  /** A send, queue edit, interrupt or mode switch is waiting for its reply: the button stays disabled. */
  busy: "send" | "edit" | "interrupt" | "mode" | null;
  editing: EditingQueued | null;
  attachments: AttachmentChip[];
  error: ComposerError | null;
  /** "Answered elsewhere": a request this client showed left the screen without an answer from here. */
  notice: string | null;
  /** The request option whose answer is in flight, until the request leaves `pending`. */
  responding: { requestId: string; optionIndex: number } | null;
  /** The bridge's word on the last answer from here (menus show it). */
  verdict: string | null;
  /** T29: review-comment blocks waiting to be appended to the box (the composer takes them once, through its own `setText`). */
  insertion: ComposerInsertion | null;
}

/** Blocks to append to the draft, newest request wins; `focus` says whether the box takes focus (a desktop; a phone must not raise its keyboard). */
export interface ComposerInsertion {
  id: number;
  blocks: string[];
  focus: boolean;
}

export const EMPTY_COMPOSER: ThreadComposer = {
  busy: null,
  editing: null,
  attachments: [],
  error: null,
  notice: null,
  responding: null,
  verdict: null,
  insertion: null,
};

/** What this client sent, by commandId, so a later `dispatch.failed` can offer Retry with the same text. */
interface SentMessage {
  threadId: string;
  text: string;
  attachments: ChatAttachment[];
}

interface ComposerStore {
  byThread: Record<string, ThreadComposer>;
  sent: Record<string, SentMessage>;
}

export const useComposerStore = create<ComposerStore>(() => ({ byThread: {}, sent: {} }));

export function useThreadComposer(threadId: string): ThreadComposer {
  return useComposerStore((s) => s.byThread[threadId] ?? EMPTY_COMPOSER);
}

export function getThreadComposer(threadId: string): ThreadComposer {
  return useComposerStore.getState().byThread[threadId] ?? EMPTY_COMPOSER;
}

export function patchComposer(threadId: string, patch: Partial<ThreadComposer>): void {
  useComposerStore.setState((s) => ({
    byThread: { ...s.byThread, [threadId]: { ...(s.byThread[threadId] ?? EMPTY_COMPOSER), ...patch } },
  }));
}

export function sentMessage(commandId: string | undefined): SentMessage | null {
  return commandId ? (useComposerStore.getState().sent[commandId] ?? null) : null;
}

// ── Review comments (T29) ───────────────────────────────────────────────────────────────────────

let nextInsertId = 1;

/** Ask the composer to append these blocks to its text. It limits them (10 a message, 12,000 characters) and says what went in. */
export function requestInsert(threadId: string, blocks: string[], opts: { focus?: boolean } = {}): void {
  patchComposer(threadId, { insertion: { id: nextInsertId++, blocks, focus: opts.focus ?? false } });
}

export function consumeInsert(threadId: string, id: number): void {
  if (getThreadComposer(threadId).insertion?.id === id) patchComposer(threadId, { insertion: null });
}

/** The box's text as the composer last published it (a queued edit's buffer included), for the "in message" marks. */
const useComposerText = create<{ text: Record<string, string> }>(() => ({ text: {} }));

export function publishComposerText(threadId: string, text: string): void {
  if (useComposerText.getState().text[threadId] === text) return;
  useComposerText.setState((s) => ({ text: { ...s.text, [threadId]: text } }));
}

/** What the box holds now: the published text, else the saved draft. */
export function useDraftText(threadId: string): string {
  return useComposerText((s) => s.text[threadId]) ?? loadDraft(threadId) ?? "";
}

// ── Seams ───────────────────────────────────────────────────────────────────────────────────────

let commandDeps: () => CommandDeps = defaultCommandDeps;
let upload: (paneId: string, file: File) => ReturnType<typeof uploadImage> = uploadImage;

/** Test seam: the command client's fetch and id source, and the uploader. */
export function __setComposerDeps(deps: { command?: () => CommandDeps; upload?: typeof uploadImage }): void {
  if (deps.command) commandDeps = deps.command;
  if (deps.upload) upload = deps.upload;
}

/** Words for a refused command, from T05/T06's codes and `error` names. */
export function refusalText(err: unknown): string {
  if (err instanceof V2CommandError) {
    const why = err.body?.error ?? "";
    const known: Record<string, string> = {
      "thread-busy": "The agent is working. Queue it or wait.",
      "needs-response": "The agent is waiting for an answer first.",
      "thread-archived": "This thread is archived.",
      "pane-gone": "The pane is gone.",
      "queue-unsupported": "This agent cannot queue messages.",
      "interrupt-unsupported": "This agent cannot be stopped from Sightr.",
      "not-working": "The agent is not working.",
      "already-interrupting": "Already stopping.",
      "already-sending": "That message is being sent.",
      "queue-changed": "The queue changed. Try again.",
      "text-too-long": "The message is too long.",
      "empty-text": "Nothing to send.",
      "prompt-changed": "The dialog changed on screen. Check it and try again.",
      "no-free-text": "This question has no empty answer box on screen now.",
    };
    if (known[why]) return known[why];
    if (err.code === "busy") return "The pane is busy. Try again.";
    if (err.status === 403) return "This device is read-only.";
    return why || err.message;
  }
  if (err instanceof Error) return err.message || "Could not reach the bridge.";
  return "Could not reach the bridge.";
}

async function post<T extends Parameters<typeof sendCommand>[0]>(
  type: T,
  payload: CommandPayload<T>,
  commandId?: string,
): Promise<{ sequence: number }> {
  const deps = commandDeps();
  return sendCommand(type, payload, commandId ? { ...deps, newId: () => commandId } : deps);
}

// ── Send ────────────────────────────────────────────────────────────────────────────────────────

/** Ready attachments as `message.dispatch` takes them (T06's `{ path, name }`). */
export function readyAttachments(chips: readonly AttachmentChip[]): ChatAttachment[] {
  return chips.filter((c) => c.status === "done" && c.path).map((c) => ({ path: c.path!, name: c.name }));
}

/**
 * Post `message.dispatch`. Resolves true on the bridge's reply (the caller then clears the box);
 * false on a refusal, with the error banner set and the draft left alone. `busy` is set for the
 * whole round trip, so a second tap cannot post a second dispatch.
 */
export async function dispatchMessage(input: {
  threadId: string;
  text: string;
  attachments: ChatAttachment[];
  mode: DispatchMode;
}): Promise<boolean> {
  const { threadId, text, attachments, mode } = input;
  if (getThreadComposer(threadId).busy) return false;
  const commandId = commandDeps().newId();
  useComposerStore.setState((s) => ({ sent: { ...trimSent(s.sent), [commandId]: { threadId, text, attachments } } }));
  patchComposer(threadId, { busy: "send", error: null });
  try {
    await post("message.dispatch", { threadId, text, mode, ...(attachments.length > 0 ? { attachments } : {}) }, commandId);
    consumeSent(threadId, text); // T29: the review comments whose block went out
    clearDraft(threadId);
    patchComposer(threadId, { busy: null, attachments: [] });
    followTimeline();
    return true;
  } catch (err) {
    patchComposer(threadId, { busy: null, error: { text: refusalText(err), retry: { text, attachments } } });
    return false;
  }
}

/** Keep the sent-by-id map small: the newest 20. */
function trimSent(sent: Record<string, SentMessage>): Record<string, SentMessage> {
  const keys = Object.keys(sent);
  if (keys.length < 20) return sent;
  return Object.fromEntries(keys.slice(-19).map((k) => [k, sent[k]!]));
}

export async function interruptRun(threadId: string): Promise<void> {
  if (getThreadComposer(threadId).busy === "interrupt") return;
  patchComposer(threadId, { busy: "interrupt" });
  try {
    await post("run.interrupt", { threadId });
  } catch (err) {
    showToast(refusalText(err), "error");
  } finally {
    patchComposer(threadId, { busy: null });
  }
}

// ── Permission mode (T08) ───────────────────────────────────────────────────────────────────────

/**
 * Post `thread.permissionMode.set`. The bridge cycles the harness's mode key and reads its footer; the
 * thread's `permissionMode` changes through the stream when it lands. A refusal sets the error banner
 * with `describe`'s words (the caller knows the mode labels). Resolves true on the bridge's reply.
 */
export async function setPermissionMode(
  threadId: string,
  mode: string,
  opts: { confirmBypass?: boolean; describe: (err: unknown) => string },
): Promise<boolean> {
  if (getThreadComposer(threadId).busy) return false;
  patchComposer(threadId, { busy: "mode", error: null });
  try {
    await post("thread.permissionMode.set", { threadId, mode, ...(opts.confirmBypass ? { confirmBypass: true } : {}) });
    patchComposer(threadId, { busy: null });
    return true;
  } catch (err) {
    patchComposer(threadId, { busy: null, error: { text: opts.describe(err) } });
    return false;
  }
}

// ── Runtime requests ────────────────────────────────────────────────────────────────────────────

/** Answer a request with one of its options. The option stays busy until the request leaves `pending`. */
/** `responding.optionIndex` while a checkbox step's wanted set is in flight (its advance button). */
export const RESPONDING_ADVANCE = -1;

/** `responding.optionIndex` while a Back step is in flight, and while a Next step is. */
export const RESPONDING_BACK = -3;
export const RESPONDING_NEXT = -4;

/** How long a step move may stay busy if the next step never shows up (the terminal ignored the key). */
export const NAVIGATE_SETTLE_MS = 4_000;

/** `responding.optionIndex` while a typed answer to a `freeText` question is in flight. */
export const RESPONDING_TEXT = -2;

/**
 * Answer a `freeText` question with the operator's own words: the bridge types them into the dialog's
 * free-text row and presses Enter. Resolves true when the bridge took it; false on a refusal (the
 * card keeps the draft, and the verdict says why).
 */
export async function respondWithText(threadId: string, requestId: string, text: string): Promise<boolean> {
  const current = getThreadComposer(threadId).responding;
  if (current && current.requestId === requestId) return false;
  patchComposer(threadId, { responding: { requestId, optionIndex: RESPONDING_TEXT }, verdict: null });
  try {
    await post("runtime-request.respond", { requestId, text });
    verdictFor(threadId, requestId, "Sent to the agent.");
    return true;
  } catch (err) {
    verdictFor(threadId, requestId, refusalText(err), { responding: null });
    return false;
  }
}

/**
 * The answer's word, only while its card is still the one up. The bridge publishes the next dialog
 * as soon as the keys land, often before the respond reply arrives; by then the composer has moved
 * to the next card (ChatComposer clears `responding`), and a late "Sent to the agent." would sit under
 * a question nobody has answered yet (live 2026-10-18: Claude's second Read card).
 */
function verdictFor(threadId: string, requestId: string, verdict: string, extra: Partial<ThreadComposer> = {}): void {
  if (getThreadComposer(threadId).responding?.requestId !== requestId) return;
  patchComposer(threadId, { ...extra, verdict });
}

/**
 * Walk a multi-question ask one step (Left / Right in the terminal). Nothing is answered: the card is
 * replaced by the next step's. The card stays busy until then, so ChatComposer does not call the move
 * "answered elsewhere"; if no new card comes, it frees itself after `NAVIGATE_SETTLE_MS`.
 */
export async function navigateRequest(threadId: string, requestId: string, direction: "back" | "next"): Promise<void> {
  const current = getThreadComposer(threadId).responding;
  if (current && current.requestId === requestId) return;
  patchComposer(threadId, {
    responding: { requestId, optionIndex: direction === "back" ? RESPONDING_BACK : RESPONDING_NEXT },
    verdict: null,
  });
  try {
    await post("runtime-request.navigate", { requestId, direction });
    setTimeout(() => {
      if (getThreadComposer(threadId).responding?.requestId === requestId) patchComposer(threadId, { responding: null });
    }, NAVIGATE_SETTLE_MS);
  } catch (err) {
    patchComposer(threadId, { responding: null, verdict: refusalText(err) });
  }
}

/** Answer a request: one option by index, or a checkbox step's wanted set of boxes (T17). */
export async function respondToRequest(threadId: string, requestId: string, answer: number | readonly number[]): Promise<void> {
  const current = getThreadComposer(threadId).responding;
  if (current && current.requestId === requestId) return;
  const optionIndex = typeof answer === "number" ? answer : RESPONDING_ADVANCE;
  patchComposer(threadId, { responding: { requestId, optionIndex }, verdict: null });
  try {
    await post(
      "runtime-request.respond",
      typeof answer === "number" ? { requestId, optionIndex: answer } : { requestId, optionIndices: [...answer] },
    );
    verdictFor(threadId, requestId, "Sent to the agent.");
  } catch (err) {
    verdictFor(threadId, requestId, refusalText(err), { responding: null });
  }
}

// ── The queue ───────────────────────────────────────────────────────────────────────────────────

export async function reorderQueue(threadId: string, ids: string[]): Promise<void> {
  try {
    await post("queued.reorder", { threadId, ids });
  } catch (err) {
    showToast(refusalText(err), "error");
  }
}

/** Move one row to `index` (0-based) and post the whole new order. */
export function moveQueued(threadId: string, queue: readonly QueuedMessage[], id: string, index: number): Promise<void> {
  const ids = queue.map((q) => q.id).filter((x) => x !== id);
  const clamped = Math.max(0, Math.min(index, ids.length));
  ids.splice(clamped, 0, id);
  if (ids.every((x, i) => queue[i]?.id === x)) return Promise.resolve();
  return reorderQueue(threadId, ids);
}

export async function resumeQueue(threadId: string): Promise<void> {
  try {
    await post("queue.resume", { threadId });
  } catch (err) {
    showToast(refusalText(err), "error");
  }
}

/** Begin editing a queued message in the box. */
export function startQueuedEdit(threadId: string, row: QueuedMessage, currentText: string): void {
  const prior = getThreadComposer(threadId).editing;
  patchComposer(threadId, {
    editing: { id: row.id, originalText: row.text, savedDraft: prior ? prior.savedDraft : currentText },
  });
}

/** Leave the edit. Returns the box's own draft to put back. */
export function endQueuedEdit(threadId: string): string {
  const editing = getThreadComposer(threadId).editing;
  patchComposer(threadId, { editing: null });
  return editing?.savedDraft ?? "";
}

export async function saveQueuedEdit(threadId: string, text: string): Promise<boolean> {
  const editing = getThreadComposer(threadId).editing;
  if (!editing || getThreadComposer(threadId).busy) return false;
  patchComposer(threadId, { busy: "edit" });
  try {
    await post("queued.edit", { id: editing.id, text });
    consumeSent(threadId, text);
    patchComposer(threadId, { busy: null });
    return true;
  } catch (err) {
    patchComposer(threadId, { busy: null, error: { text: refusalText(err) } });
    return false;
  }
}

/** How long Undo waits for the re-queued row to show up before it gives up on the position. */
export const REQUEUE_WAIT_MS = 5_000;

/** Wait for the open thread's queue to hold a row not in `before`. */
function waitForNewRow(threadId: string, before: ReadonlySet<string>): Promise<string | null> {
  const find = () => {
    const state = useThreadStore.getState().current;
    if (!state || state.threadId !== threadId) return null;
    return state.queue.find((q) => !before.has(q.id))?.id ?? null;
  };
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, REQUEUE_WAIT_MS);
    const unsubscribe = useThreadStore.subscribe(() => {
      const id = find();
      if (id) {
        clearTimeout(timer);
        unsubscribe();
        resolve(id);
      }
    });
  });
}

/** Cancel a queued message, with "Removed from queue · Undo" that puts it back where it was. */
export async function cancelQueued(threadId: string, row: QueuedMessage, queue: readonly QueuedMessage[]): Promise<void> {
  const index = queue.findIndex((q) => q.id === row.id);
  try {
    await post("queued.cancel", { id: row.id });
  } catch (err) {
    showToast(refusalText(err), "error");
    return;
  }
  const noticeId = showThreadUndoNotice({
    action: "Removed from queue",
    threadId,
    undo: async () => {
      const current = useThreadStore.getState().current;
      const before = new Set((current?.threadId === threadId ? current.queue : []).map((q) => q.id));
      try {
        await post("message.dispatch", {
          threadId,
          text: row.text,
          mode: "queue",
          ...(row.attachments.length > 0 ? { attachments: row.attachments } : {}),
        });
      } catch (err) {
        showToast(refusalText(err), "error");
        return;
      }
      const id = await waitForNewRow(threadId, before);
      const state = useThreadStore.getState().current;
      if (!id || !state || state.threadId !== threadId) return;
      await moveQueued(threadId, state.queue, id, index);
    },
  });
  void noticeId;
}

/** "Steer now" on a queued row: send it as a steer, then take it out of the queue. */
export async function steerQueued(threadId: string, row: QueuedMessage): Promise<void> {
  if (getThreadComposer(threadId).busy) return;
  patchComposer(threadId, { busy: "send" });
  try {
    await post("message.dispatch", {
      threadId,
      text: row.text,
      mode: "steer",
      ...(row.attachments.length > 0 ? { attachments: row.attachments } : {}),
    });
  } catch (err) {
    patchComposer(threadId, { busy: null });
    showToast(refusalText(err), "error");
    return;
  }
  patchComposer(threadId, { busy: null });
  followTimeline();
  try {
    await post("queued.cancel", { id: row.id });
  } catch {
    // Already sent or gone: the steer carries the text either way.
  }
}

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────

const files = new Map<string, File>();
const uploads = new Map<string, Promise<void>>();
let nextChip = 1;

function patchChip(threadId: string, id: string, patch: Partial<AttachmentChip>): void {
  const chips = getThreadComposer(threadId).attachments;
  if (!chips.some((c) => c.id === id)) return;
  patchComposer(threadId, { attachments: chips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

function startUpload(threadId: string, paneId: string, id: string): void {
  const file = files.get(id);
  if (!file) return;
  patchChip(threadId, id, { status: "uploading", error: undefined });
  const job = upload(paneId, file)
    .then((res) => {
      if (res.ok) patchChip(threadId, id, { status: "done", path: res.path });
      else patchChip(threadId, id, { status: "failed", error: res.error });
    })
    .catch((err: unknown) => {
      patchChip(threadId, id, { status: "failed", error: err instanceof Error ? err.message : "Upload failed" });
    })
    .finally(() => {
      if (uploads.get(id) === job) uploads.delete(id);
    });
  uploads.set(id, job);
}

/** Add files as chips; each starts uploading at once. */
export function addAttachments(threadId: string, paneId: string, added: readonly File[]): void {
  const chips: AttachmentChip[] = added.map((file) => {
    const id = `a${nextChip++}`;
    files.set(id, file);
    return { id, name: file.name || "attachment", status: "uploading", ...(file.type.startsWith("image/") ? { image: true } : {}) };
  });
  patchComposer(threadId, { attachments: [...getThreadComposer(threadId).attachments, ...chips] });
  for (const chip of chips) startUpload(threadId, paneId, chip.id);
}

/** The staged file behind a chip, while it is staged (thumbnails and the viewer read it). */
export function attachmentFile(id: string): File | undefined {
  return files.get(id);
}

export function retryAttachment(threadId: string, paneId: string, id: string): void {
  startUpload(threadId, paneId, id);
}

export function removeAttachment(threadId: string, id: string): void {
  files.delete(id);
  uploads.delete(id);
  patchComposer(threadId, { attachments: getThreadComposer(threadId).attachments.filter((c) => c.id !== id) });
}

/** Resolves once every upload in flight for the thread has settled (Send waits for them). */
export async function settleUploads(threadId: string): Promise<AttachmentChip[]> {
  const pending = getThreadComposer(threadId)
    .attachments.map((c) => uploads.get(c.id))
    .filter((p): p is Promise<void> => p !== undefined);
  await Promise.all(pending);
  return getThreadComposer(threadId).attachments;
}

/** Test helper. */
export function __resetComposerState(): void {
  files.clear();
  uploads.clear();
  nextChip = 1;
  commandDeps = defaultCommandDeps;
  upload = uploadImage;
  useComposerStore.setState({ byThread: {}, sent: {} }, true);
  useComposerText.setState({ text: {} }, true);
  useComposerSettings.setState(initialSettings(), true);
  dismissThreadUndoNotice();
}
