import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SILENT_AUDIT, type AuditDetail, type AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import { makeRoomForUpload, TEXT_SNIFF_BYTES, uploadExt } from "./uploads.ts";
import { DEFAULT_PROMPT_TAIL_LINES, verifyExpectedPrompt, type PromptBindingResult } from "./prompt-binding.ts";
import type { ActionResponse, UploadResponse } from "../shared/wire.ts";
import { failureText, json, requireJsonBody, secure, text } from "./responses.ts";
import { paneKey, PaneBusyError, type PaneQueue } from "./pane-queue.ts";
import { effectiveSettings } from "./runtime-settings.ts";
import { MAX_REPLY_BYTES } from "../shared/limits.ts";
import { normalizeChord } from "./operator-keys.ts";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
// Multipart wraps the file in a boundary + part headers, so a legitimately-sized file arrives a
// little over MAX_UPLOAD_BYTES on the wire. Allow a small slack for the Content-Length pre-check.
const MAX_UPLOAD_OVERHEAD = 64 * 1024; // 64 KB
// Hard cap the runtime enforces on ANY request body (Bun.serve maxRequestBodySize). Bigger than the
// upload cap + overhead so the handler's own 413 fires first for honest clients; this cuts off a
// chunked or lying client that never sends an accurate Content-Length.
const MAX_EXPECTED_PROMPT_CHARS = MAX_REPLY_BYTES;
const MAX_READ_LINES = 10_000;
// Caps mirror the web conformance limits in web/src/lib/harness/conformance.ts.
const MAX_SUBMIT_KEYS = 4;
const MAX_SUBMIT_KEY_CHARS = 32;
export type SleepFn = (ms: number) => Promise<void>;
const PROMPT_BINDING_BLANK_LINE_HEADROOM = 6;
export interface ReplySender {
  sendPaneText(paneId: string, text: string): Promise<void>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
}

/** Outcome of the two-step send. `textDelivered` is only meaningful on the failure branch. */
export type ReplyOutcome =
  | { ok: true; textDelivered: boolean }
  | { ok: false; error: string; textDelivered: boolean };

/**
 * The reply's two one-shot RPCs — type the text, then send the submit key(s) — as a pure function so
 * the partial-failure branch is unit-testable with a fake client. The important case: if the text
 * lands but the submit keypress fails, we surface a distinct, actionable error and `textDelivered:
 * true` so the client knows NOT to resend (which would duplicate the already-typed text). Pure +
 * exported.
 */
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pause between typing and Enter so the TUI accepts the submit key (preview-action polls ~350ms). */
const REPLY_SETTLE_MS = 350;

export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  try {
    if (txt) {
      await client.sendPaneText(paneId, txt);
      textDelivered = true;
    }
    if (submit) {
      if (txt) await sleep(REPLY_SETTLE_MS);
      // One RPC per key. A single pane.send_keys write of [Right, Enter] (or paste-terminator +
      // Enter) is what Cursor CLI and Grok on Windows ConPTY swallow: the TUI inserts the text and
      // buffers Enter until a later input event, so the composer shows the message unsubmitted.
      // Separate writes, with the same settle as type-then-Enter, keep the submit on its own event.
      for (let i = 0; i < submitKeys.length; i++) {
        if (i > 0) await sleep(REPLY_SETTLE_MS);
        await client.sendPaneKeys(paneId, [submitKeys[i]!]);
      }
    }
    return { ok: true, textDelivered };
  } catch (err) {
    if (textDelivered && submit) {
      // Text is already in the pane — only the submit failed. Tell the operator to check/submit it
      // by hand rather than resend, and flag textDelivered so a resend-on-error UI can hold off.
      return {
        ok: false,
        textDelivered: true,
        error: "typed into the pane but not submitted — check the pane before resending",
      };
    }
    return { ok: false, textDelivered, error: failureText("reply", err) };
  }
}

export async function replyPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  queue: PaneQueue,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { text?: string; submit?: boolean; expected_prompt?: unknown; submit_keys?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const expected = expectedPrompt(body);
  if (!expected.ok) return text("bad expected_prompt", 400);
  const requested = submitKeysField(body);
  if (!requested.ok) return text("bad submit_keys", 400);
  const txt = body.text ?? "";
  const submit = body.submit ?? true;
  const ae = req.headers.get("accept-encoding");
  const key = paneKey(paneId);
  const submitKeys = requested.keys ?? effectiveSettings(cfg).submitKeys;
  let queued: { binding: PromptBindingCheck | null; outcome: ReplyOutcome | null };
  try {
    queued = await queue.run(key, async () => {
      const binding = expected.present
        ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
        : null;
      if (binding && !binding.ok) return { binding, outcome: null };
      return { binding, outcome: await sendReplySteps(herdr, paneId, txt, submit, submitKeys) };
    });
  } catch (err) {
    if (err instanceof PaneBusyError) return paneBusy(ae);
    throw err;
  }
  const { binding, outcome } = queued;
  if (binding && !binding.ok) {
    audit.record({
      action: "reply",
      paneId,
      detail: {
        text: txt,
        submit,
        keys: submitKeys,
        sent: false,
        textDelivered: false,
        promptBinding: binding.audit,
      },
    });
    return promptBindingFailure(binding, ae);
  }
  if (!outcome) throw new Error("reply queue returned no outcome");
  const detail: AuditDetail = {
    text: txt,
    submit,
    keys: submitKeys,
  };
  if (binding) detail.promptBinding = binding.audit;
  if (!outcome.ok) {
    detail.sent = false;
    detail.textDelivered = outcome.textDelivered;
  }
  audit.record({ action: "reply", paneId, detail });
  if (outcome.ok) return json({ ok: true } satisfies ActionResponse, ae);
  return json(
    { ok: false, error: outcome.error, textDelivered: outcome.textDelivered } satisfies ActionResponse,
    ae,
  );
}

export async function keysPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  queue: PaneQueue,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const bad = requireJsonBody(req);
  if (bad) return bad;
  let body: { keys?: unknown; expected_prompt?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const expected = expectedPrompt(body);
  if (!expected.ok) return text("bad expected_prompt", 400);
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) return text("no keys", 400);
  const ae = req.headers.get("accept-encoding");
  const key = paneKey(paneId);
  let queued: { binding: PromptBindingCheck | null; sent: boolean; error: string | null };
  try {
    queued = await queue.run(key, async () => {
      const binding = expected.present
        ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
        : null;
      if (binding && !binding.ok) return { binding, sent: false, error: null };
      try {
        await herdr.sendPaneKeys(paneId, keys);
        return { binding, sent: true, error: null };
      } catch (err) {
        return { binding, sent: false, error: failureText("key send", err) };
      }
    });
  } catch (err) {
    if (err instanceof PaneBusyError) return paneBusy(ae);
    throw err;
  }
  const { binding, sent, error } = queued;
  if (binding && !binding.ok) {
    audit.record({
      action: "keys",
      paneId,
      detail: { keys, sent: false, promptBinding: binding.audit },
    });
    return promptBindingFailure(binding, ae);
  }
  if (sent) {
    const detail: AuditDetail = { keys };
    if (binding) detail.promptBinding = binding.audit;
    audit.record({ action: "keys", paneId, detail });
    return json({ ok: true } satisfies ActionResponse, ae);
  }
  const detail: AuditDetail = { keys, sent: false };
  if (binding) detail.promptBinding = binding.audit;
  audit.record({ action: "keys", paneId, detail });
  return json({ ok: false, error: error ?? "key send failed" } satisfies ActionResponse, ae);
}

type SubmitKeysField =
  | { ok: true; keys: string[] | null }
  | { ok: false };

function submitKeysField(body: object): SubmitKeysField {
  if (!Object.prototype.hasOwnProperty.call(body, "submit_keys")) return { ok: true, keys: null };
  const value = (body as { submit_keys?: unknown }).submit_keys;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SUBMIT_KEYS) return { ok: false };
  const keys: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw.length > MAX_SUBMIT_KEY_CHARS) return { ok: false };
    const chord = normalizeChord(raw);
    if (chord === null) return { ok: false };
    keys.push(chord);
  }
  return { ok: true, keys };
}

type ExpectedPrompt =
  | { ok: true; present: false }
  | { ok: true; present: true; value: string }
  | { ok: false };

function expectedPrompt(body: object): ExpectedPrompt {
  if (!Object.prototype.hasOwnProperty.call(body, "expected_prompt")) {
    return { ok: true, present: false };
  }
  const value = (body as { expected_prompt?: unknown }).expected_prompt;
  if (typeof value !== "string" || value.length > MAX_EXPECTED_PROMPT_CHARS) {
    return { ok: false };
  }
  return { ok: true, present: true, value };
}

type PromptBindingCheck =
  | {
      ok: true;
      audit: { checked: true; passed: true; expected: string };
    }
  | {
      ok: false;
      error: string;
      status: 409 | 502;
      code?: "prompt_changed";
      audit: {
        checked: true;
        passed: false;
        expected: string;
        reason: Extract<PromptBindingResult, { ok: false }>["reason"] | "read_failed";
      };
    };

// There is deliberately no expected_blocked flag. agent_status is not carried by pane.read, only by
// session.snapshot, so checking it would cost a second RPC before the write and widen the very
// window this feature exists to shrink. The region check already subsumes it: if the exact prompt
// text is still on screen, that prompt is still what the pane is showing.
async function checkPromptBinding(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  expected: string,
): Promise<PromptBindingCheck> {
  let fresh: PaneRead;
  try {
    const expectedRawLines = expected.split(/\r\n?|\n/).length;
    const bindingReadLines = Math.min(
      MAX_READ_LINES,
      Math.max(
        effectiveSettings(cfg).readLines,
        expectedRawLines + DEFAULT_PROMPT_TAIL_LINES + PROMPT_BINDING_BLANK_LINE_HEADROOM,
      ),
    );
    // Keep this coupled to readPane(): use its recent source and ANSI format so the bridge verifies
    // the same kind of pane data the GET handler serves. The line count deliberately does not follow
    // cfg.readLines alone because a small legal setting may not contain the expected region; include
    // room for the accepted tail and for blank separator lines that normalization drops.
    fresh = await herdr.readPane(paneId, "recent", bindingReadLines, "ansi");
  } catch (err) {
    return {
      ok: false,
      error: failureText("herdr read", err),
      status: 502,
      audit: { checked: true, passed: false, expected, reason: "read_failed" },
    };
  }

  const result = verifyExpectedPrompt(fresh.text, expected);
  if (!result.ok) {
    return {
      ok: false,
      error: "prompt changed",
      status: 409,
      code: "prompt_changed",
      audit: { checked: true, passed: false, expected, reason: result.reason },
    };
  }

  // This is a mitigation, not a guarantee. The re-read and the send_keys are two separate herdr
  // RPCs, so a TOCTOU window remains by construction; it shrinks from seconds (poll interval + push
  // latency + human reaction time) to the few milliseconds between two local RPCs. It removes the
  // human-latency portion of the window, which is where essentially all of the real risk lives.
  // Closing the window completely would need a conditional-input primitive in herdr (send_keys with
  // a precondition rejected atomically server-side), which does not exist today.
  return { ok: true, audit: { checked: true, passed: true, expected } };
}

function paneBusy(acceptEncoding: string | null): Response {
  return json({ ok: false, error: "pane busy" } satisfies ActionResponse, acceptEncoding, 503);
}

function promptBindingFailure(
  result: Extract<PromptBindingCheck, { ok: false }>,
  acceptEncoding: string | null,
): Response {
  return json(
    {
      ok: false,
      error: result.error,
      ...(result.code ? { code: result.code } : {}),
    } satisfies ActionResponse,
    acceptEncoding,
    result.status,
  );
}

// Close a pane ("kill the agent"). Structural op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
export async function closePane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  queue: PaneQueue,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  try {
    await queue.run(paneKey(paneId), () => herdr.closePane(paneId));
    audit.record({ action: "pane.close", paneId, detail: {} });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    if (err instanceof PaneBusyError) return paneBusy(ae);
    audit.record({ action: "pane.close", paneId, detail: { sent: false, reason: "close failed" } });
    return json({ ok: false, error: failureText("close pane", err) } satisfies ActionResponse, ae);
  }
}

// Set or clear a pane's label. Structural metadata op — strictly less powerful than the text/keys
// injection the bridge already allows, so it stays within the existing remote-shell threat model.
// The body's `label` must be a string or null; a blank string clears (so a user can wipe a label by
// saving an empty field), which we send to Herdr as `label: null`.
export async function renamePane(
  herdr: HerdrClient,
  paneId: string,
  req: Request,
  queue: PaneQueue,
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
  if (body.label !== null && typeof body.label !== "string") return text("bad label", 400);
  const trimmed = typeof body.label === "string" ? body.label.trim() : "";
  const label = trimmed.length > 0 ? trimmed : null;
  try {
    await queue.run(paneKey(paneId), () => herdr.renamePane(paneId, label));
    audit.record({ action: "pane.rename", paneId, detail: { label } });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    if (err instanceof PaneBusyError) return paneBusy(ae);
    return json({ ok: false, error: failureText("rename pane", err) } satisfies ActionResponse, ae);
  }
}

export async function uploadPane(
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  // Reject an oversize upload by its declared Content-Length BEFORE buffering — req.formData()
  // reads the whole body into memory first, so a 100 MB "file" would be materialised just to fail
  // the size check below. Multipart adds a boundary + part headers, so allow a small slack.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD) {
    return secure(
      new Response(
        JSON.stringify({
          ok: false,
          error: "file too large (max 10 MB)",
        } satisfies UploadResponse),
        { status: 413, headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return text("expected multipart form data", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ ok: false, error: "no file" } satisfies UploadResponse, ae);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "file too large (max 10 MB)" } satisfies UploadResponse, ae);
  }
  try {
    // formData() has already buffered the body, so this is a copy, not a second read. Take it once
    // and use it for both the sniff and the write.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = uploadExt(file.name, bytes.subarray(0, TEXT_SNIFF_BYTES));
    if (!ext) {
      // Deliberately does not echo file.type back: it is client-controlled and, now that the bytes
      // (for an image) and the name-plus-bytes (for a text file) decide, it is not the reason for
      // the refusal either.
      return json(
        {
          ok: false,
          error: "unsupported file type (images: PNG, JPEG, GIF, WebP; text: markdown, code, config and data files)",
        } satisfies UploadResponse,
        ae,
      );
    }
    const dir = join(cfg.stateDir, "uploads");
    // 0700 — uploads (and the state dir they live under) may hold sensitive files; keep them
    // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // ...but mkdir applies `mode` only to dirs it CREATES, so a dir left over from an earlier build
    // (or from a SIGHTR_STATE_DIR pointing at something shared) keeps its old perms. Re-assert it.
    // Best-effort: if we don't own the dir we still write the file at 0600 below, which is the
    // protection that actually matters. cfg.stateDir itself is left alone on purpose — the operator
    // chose that path and may share it deliberately.
    await chmod(dir, 0o700).catch(() => {});
    // Bound the directory's total size, evicting oldest-first (issue #9).
    if (!(await makeRoomForUpload(dir, file.size))) {
      audit.record({
        action: "upload",
        paneId,
        detail: { filename: file.name, size: file.size, sent: false, reason: "storage full" },
      });
      return json({ ok: false, error: "upload storage full" } satisfies UploadResponse, ae);
    }
    const safePane = paneId.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = `${safePane}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const fullPath = join(dir, filename);
    // node:fs write (not Bun.write, which has no mode option) so the file is owner-only from the
    // moment it exists — a chmod after the fact leaves a window where it is world-readable at the
    // process umask. The name is a fresh UUID, so O_CREAT always applies the mode.
    await writeFile(fullPath, bytes, { mode: 0o600 });
    audit.record({
      action: "upload",
      paneId,
      detail: { filename: file.name, size: file.size, saved: filename },
    });
    return json({ ok: true, path: fullPath } satisfies UploadResponse, ae);
  } catch (err) {
    audit.record({
      action: "upload",
      paneId,
      detail: { filename: file.name, size: file.size, sent: false, reason: "write failed" },
    });
    return json({ ok: false, error: failureText("upload", err) } satisfies UploadResponse, ae);
  }
}

