// The closed-loop dialog RECIPES, with their I/O injected. Two callers run them:
//
//   - v1's action modules (lib/multi-select-action.ts, lib/preview-action.ts), with the browser's
//     pane read (`fetchPane` + the pane's adapter) and `sendKeys` through the bridge's prompt binding.
//   - the bridge's v2 `runtime-request.respond` (bridge/threads/respond.ts, T17), with
//     `herdr.readPane(paneId, "visible", …)` + dialog-kit's parse and `sendKeysPaced`.
//
// This is the same move spec 24 made for the guarded send (`guarded-send.ts`): the algorithm lives
// once, and each side supplies `read`, `send` and `sleep`. The entry guard is the caller's (v1's
// `guardDialog`, the bridge's prompt binding); every recipe here starts after it has passed and gets
// the verified `region` to bind its first write to.
//
// The invariants every recipe keeps:
//   - A key goes out only after a fresh `read()` that passed the kind's identity comparator (or the
//     caller's entry guard, for the first key).
//   - Only the FIRST write carries `region`. Later steps change the screen on purpose, so the
//     original region would refuse every valid later write; the identity check guards them instead.
//   - No Enter on a multi-select until a read shows the pointer on the advance row.
//   - A read that shows another dialog aborts with `changed` and sends nothing more.
//
// LEAF IMPORTS ONLY: the bridge imports this file at runtime (same rule as harness/dialog-kit.ts).
// It reaches only the neutral model modules, never `api.ts`, the registry or a package.

import { multiSelectIdentity, type MultiSelectModel } from "./harness/multi-select-model";
import { previewCoreEqual, previewStructureEqual, type PreviewSelectModel } from "./harness/preview-model";

/**
 * The outcome of a recipe. `sent` = the keys went through; `changed` = the screen is not the dialog
 * the answer was aimed at (nothing more was sent; refresh); `error` = a transport failure.
 */
export type RecipeResult = { status: "sent" } | { status: "changed" } | { status: "error"; error: string };

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded verification polling between choreography steps (~2.8 s before giving up). */
export const POLL_ATTEMPTS = 8;
export const POLL_DELAY_MS = 350;
/**
 * The pointer settles fast after a nav key (a cheap redraw, unlike the note-focus race the 350 ms
 * POLL_DELAY guards), so the pointer walks re-read on this short cadence and move one row per read.
 */
export const NAV_SETTLE_MS = 250;

/** What a recipe needs from its caller. */
export interface RecipeIO<M> {
  /** One fresh pane read, re-derived to this kind's model (null = none on screen). May throw. */
  read(): Promise<M | null>;
  /** Send `keys`. `region`, when given, binds the write to that literal on-screen text. */
  send(keys: string[], region?: string): Promise<RecipeResult>;
  sleep: Sleep;
}

/**
 * Poll (bounded) until `accept` passes on a fresh read. Three-valued:
 *   - `"ok"`      — `accept` passed.
 *   - `"drifted"` — a fresh model failed `identity` against `tapped` (another dialog), or every read
 *                   came back empty (the dialog is gone). No further key may be sent.
 *   - `"timeout"` — still our dialog, but the awaited state never came. A bounded retry is safe.
 * A transient empty read mid-poll keeps polling (a redraw can hide the tail for a frame).
 */
export async function pollModel<M>(
  io: Pick<RecipeIO<M>, "read" | "sleep">,
  tapped: M,
  accept: (m: M) => boolean,
  identity: (a: M, b: M) => boolean,
): Promise<"ok" | "drifted" | "timeout"> {
  let sawDialog = false;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await io.sleep(POLL_DELAY_MS);
    let model: M | null;
    try {
      model = await io.read();
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (!model) continue;
    sawDialog = true;
    if (accept(model)) return "ok";
    if (!identity(model, tapped)) return "drifted";
  }
  return sawDialog ? "timeout" : "drifted";
}

// ── Preview-select ──────────────────────────────────────────────────────────────────────────────

/**
 * Select option `n` of a preview dialog: digit (bound to `region`) → poll until the pointer sits on
 * row `n` of the same dialog with its note untouched → Enter. A `[digit, Enter]` pair in one write
 * picks the WRONG row (the TUI handles both in one input chunk and Enter sees the old pointer), so
 * Enter waits for the verified read. If the pointer never converges, only the pointer moved.
 */
export async function previewSelectRecipe(
  io: RecipeIO<PreviewSelectModel>,
  tapped: PreviewSelectModel,
  n: number,
  region: string | undefined,
): Promise<RecipeResult> {
  const digit = await io.send([String(n)], region);
  if (digit.status !== "sent") return digit;
  const pointed = await pollModel(
    io,
    tapped,
    (m) => previewStructureEqual(m, tapped) && (m.options.find((o) => o.n === n)?.pointed ?? false),
    previewCoreEqual,
  );
  if (pointed !== "ok") return { status: "changed" };
  return io.send(["Enter"]);
}

// ── Multi-select ────────────────────────────────────────────────────────────────────────────────

type CheckboxModel = Extract<MultiSelectModel, { phase: "checkbox" }>;

/** A step of a pointer walk: one arrow, or the final key once the pointer is where it belongs. */
export type WalkStep = "Up" | "Down" | { last: string };

/** Sends one macro key; only the first carries the region. Null = sent, else the failure. */
function macroSender<M>(io: RecipeIO<M>, region: string | undefined) {
  let expected = region;
  return async (keys: string[]): Promise<RecipeResult | null> => {
    const bind = expected;
    expected = undefined;
    const res = await io.send(keys, bind);
    return res.status === "sent" ? null : res;
  };
}

/**
 * Claude's Submit walk (checkbox → next screen): re-read the real pointer each step, Down toward
 * the advance row (Up if it starts on the bottom "Chat about this" row), and send Enter only from a
 * read that shows the pointer on the advance row. Every read re-checks `multiSelectIdentity`
 * (pointer-blind, checkbox-aware), so a box another device flipped aborts before Enter.
 */
export async function multiSelectAdvanceRecipe(
  io: RecipeIO<MultiSelectModel>,
  tapped: MultiSelectModel,
  region: string | undefined,
): Promise<RecipeResult> {
  if (tapped.phase !== "checkbox") return { status: "changed" };
  // Enough nudges to cross every navigable row (options + free text + Submit + Chat) with slack.
  const maxSteps = tapped.options.length + 6;
  const send = macroSender(io, region);
  for (let step = 0; step < maxSteps; step++) {
    let m: MultiSelectModel | null;
    try {
      m = await io.read();
    } catch {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!m) {
      await io.sleep(NAV_SETTLE_MS); // a redraw hid the tail — re-read without a key
      continue;
    }
    if (!multiSelectIdentity(m, tapped) || m.phase !== "checkbox") return { status: "changed" };
    if (m.pointer === "advance") return (await send(["Enter"])) ?? { status: "sent" };
    const sent = await send([m.pointer === "chat" ? "Up" : "Down"]);
    if (sent) return sent;
    await io.sleep(NAV_SETTLE_MS);
  }
  return { status: "changed" };
}

/**
 * Grok's checkbox toggle (`tab-space-enter`): Tab until the highlight sits on option `n`, then
 * Space. Never a digit (a digit on a mis-read radio submits). A null highlight (on a row the card
 * scrolled off) walks Up, which clamps at option 1. A parked card gets one Tab first.
 */
export async function tabSpaceToggleRecipe(
  io: RecipeIO<MultiSelectModel>,
  tapped: MultiSelectModel,
  n: number,
  region: string | undefined,
): Promise<RecipeResult> {
  if (tapped.phase !== "checkbox" || tapped.recipe !== "tab-space-enter") return { status: "changed" };
  const maxSteps = tapped.options.length * 2 + 4;
  const send = macroSender(io, region);
  if (tapped.parked) {
    const sent = await send(["Tab"]);
    if (sent) return sent;
    await io.sleep(NAV_SETTLE_MS);
  }
  for (let step = 0; step < maxSteps; step++) {
    let m: MultiSelectModel | null;
    try {
      m = await io.read();
    } catch {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!m) {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!multiSelectIdentity(m, tapped) || m.phase !== "checkbox") return { status: "changed" };
    if (m.recipe !== "tab-space-enter") return { status: "changed" };
    if (m.focusedN === n) return (await send(["Space"])) ?? { status: "sent" };
    const sent = await send([m.focusedN == null ? "Up" : "Tab"]);
    if (sent) return sent;
    await io.sleep(NAV_SETTLE_MS);
  }
  return { status: "changed" };
}

/**
 * Cursor's `pointer-space-s` walk: one arrow per fresh read until `step` names the final key, which
 * goes out only from a read that shows the pointer where it belongs. One key per write (Cursor drops
 * the rest of a batch).
 */
export async function pointerWalkRecipe(
  io: RecipeIO<MultiSelectModel>,
  tapped: MultiSelectModel,
  step: (m: CheckboxModel) => WalkStep,
  region: string | undefined,
): Promise<RecipeResult> {
  if (tapped.phase !== "checkbox" || tapped.recipe !== "pointer-space-s") return { status: "changed" };
  const maxSteps = tapped.options.length + 4;
  const send = macroSender(io, region);
  for (let i = 0; i < maxSteps; i++) {
    let m: MultiSelectModel | null;
    try {
      m = await io.read();
    } catch {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!m) {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!multiSelectIdentity(m, tapped) || m.phase !== "checkbox") return { status: "changed" };
    if (m.recipe !== "pointer-space-s") return { status: "changed" };
    const next = step(m);
    if (typeof next !== "string") return (await send([next.last])) ?? { status: "sent" };
    const sent = await send([next]);
    if (sent) return sent;
    await io.sleep(NAV_SETTLE_MS);
  }
  return { status: "changed" };
}

/** Cursor: walk to option `n`, then Space. `Other:` (focusedN null) is the bottom row. */
export const cursorToggleStep =
  (n: number) =>
  (m: CheckboxModel): WalkStep =>
    m.focusedN === n ? { last: "Space" } : m.focusedN == null || m.focusedN > n ? "Up" : "Down";

/** Cursor: `s` submits every question — but types into `Other:`, so step off that row first. */
export const cursorSubmitStep = (m: CheckboxModel): WalkStep => (m.focusedN == null ? "Up" : { last: "s" });

/**
 * Grok's submit: Enter submits from anywhere, after a read that still shows this dialog. A parked
 * card (`Tab/Space:question`) gets Tab first, then a fresh read, then Enter.
 */
export async function tabSpaceSubmitRecipe(
  io: RecipeIO<MultiSelectModel>,
  tapped: MultiSelectModel,
  region: string | undefined,
): Promise<RecipeResult> {
  if (tapped.phase !== "checkbox" || tapped.recipe !== "tab-space-enter") return { status: "changed" };
  const send = macroSender(io, region);
  let tabbed = false;
  for (let i = 0; i < 4; i++) {
    let m: MultiSelectModel | null;
    try {
      m = await io.read();
    } catch {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!m) {
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    if (!multiSelectIdentity(m, tapped) || m.phase !== "checkbox") return { status: "changed" };
    if (m.parked && !tabbed) {
      tabbed = true;
      const sent = await send(["Tab"]);
      if (sent) return sent;
      await io.sleep(NAV_SETTLE_MS);
      continue;
    }
    return (await send(["Enter"])) ?? { status: "sent" };
  }
  return { status: "changed" };
}

/** The checked state per option, in option order. */
export function checkedOf(m: MultiSelectModel): boolean[] {
  return m.phase === "checkbox" ? m.options.map((o) => o.checked) : [];
}

/**
 * Same checkbox dialog as `base` with the boxes `checked`: identity, except that the current
 * stepper chip's answered mark may differ (Claude flips `☐ → ☒` on the first tick and back when the
 * last box clears). Everything else — signature, question, labels, steps' labels and position — must
 * match.
 */
export function sameDialogWithChecked(m: MultiSelectModel, base: MultiSelectModel, checked: readonly boolean[]): boolean {
  if (m.phase !== "checkbox" || base.phase !== "checkbox") return false;
  if (m.options.length !== checked.length) return false;
  const steps =
    base.steps && m.steps && base.steps.length === m.steps.length
      ? base.steps.map((s, i) => (s.current ? { ...s, answered: m.steps![i]!.answered } : s))
      : base.steps;
  const expected: MultiSelectModel = {
    ...base,
    steps,
    options: base.options.map((o, i) => ({ ...o, checked: checked[i]! })),
  };
  return multiSelectIdentity(m, expected);
}

/**
 * Bring a checkbox step to the `wanted` set, then advance it — what the bridge runs for
 * `runtime-request.respond {optionIndices}` (T17). One toggle per option whose box differs, each in
 * the harness's own way (Claude: the digit; Grok: Tab-walk + Space; Cursor: pointer walk + Space),
 * and after each a poll until that one box flipped and nothing else changed. A box flipped by anyone
 * else aborts. Then the submit for the dialog's `recipe` (Claude's verified walk to the advance row,
 * Grok's Enter, Cursor's `s`), against the state the last read showed.
 */
export async function multiSelectApplyRecipe(
  io: RecipeIO<MultiSelectModel>,
  tapped: MultiSelectModel,
  wanted: readonly boolean[],
  region: string | undefined,
): Promise<RecipeResult> {
  if (tapped.phase !== "checkbox" || wanted.length !== tapped.options.length) return { status: "changed" };
  let current: MultiSelectModel = tapped;
  let bind = region;
  for (let i = 0; i < wanted.length; i++) {
    if (current.phase !== "checkbox") return { status: "changed" };
    const option = current.options[i]!;
    if (option.checked === wanted[i]) continue;
    const before = current;
    const beforeChecked = checkedOf(before);
    const expected = beforeChecked.map((c, j) => (j === i ? !c : c));

    const toggled =
      before.recipe === "tab-space-enter"
        ? await tabSpaceToggleRecipe(io, before, option.n, bind)
        : before.recipe === "pointer-space-s"
          ? await pointerWalkRecipe(io, before, cursorToggleStep(option.n), bind)
          : await io.send([String(option.n)], bind);
    bind = undefined;
    if (toggled.status !== "sent") return toggled;

    let landed: MultiSelectModel | null = null;
    const outcome = await pollModel(
      io,
      before,
      (m) => {
        if (!sameDialogWithChecked(m, before, expected)) return false;
        landed = m;
        return true;
      },
      // Until the redraw, the screen still shows the state before the key: that is not drift.
      (m) => sameDialogWithChecked(m, before, beforeChecked),
    );
    if (outcome !== "ok" || landed === null) return { status: "changed" };
    current = landed;
  }

  if (current.phase !== "checkbox") return { status: "changed" };
  if (current.recipe === "tab-space-enter") return tabSpaceSubmitRecipe(io, current, bind);
  if (current.recipe === "pointer-space-s") return pointerWalkRecipe(io, current, cursorSubmitStep, bind);
  return multiSelectAdvanceRecipe(io, current, bind);
}
