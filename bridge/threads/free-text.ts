import { pollModel, type RecipeResult, type Sleep } from "../../web/src/lib/dialog-recipes.ts";
import type { FreeTextRow } from "../../web/src/lib/harness/dialog-kit.ts";

// The operator's own answer to a question, typed into the dialog's free-text row ("Type something.")
// by `runtime-request.respond` with `text` (respond.ts). The row and its walk are the adapter's
// (dialog-kit `freeTextModel`); measured live 2026-10-18:
//   - Claude (AskUserQuestion, one question or a wizard step): the row's digit puts `❯` on it and the
//     row takes typing; the text replaces the label; Enter answers (a wizard step then advances).
//   - Pi (one question or many): arrows onto the row, Enter opens its editor; the text lands in the
//     editor; Enter submits it.
//
// The recipe is closed-loop like the T17 ones (web/src/lib/dialog-recipes.ts): every key follows a
// fresh read whose row has the same identity, nothing is typed into a row that already holds text
// (the caret would land in front of someone else's words), and Enter goes only after a read shows
// exactly our text in the row. The caller has already checked the request's bound screen and holds
// the pane's queue turn throughout.

export interface FreeTextIO {
  /** One fresh read, parsed to the free-text row (null = no such row on screen). May throw. */
  read(): Promise<FreeTextRow | null>;
  /** Send named keys, one write each. */
  send(keys: string[]): Promise<RecipeResult>;
  /** Type `text` into whatever has the keyboard. */
  type(text: string): Promise<RecipeResult>;
  sleep: Sleep;
}

/** The outcome, plus whether our text reached the row (then a retry must not type it again). */
export type FreeTextResult = RecipeResult & { typed?: boolean };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const sameRow = (a: FreeTextRow, b: FreeTextRow) => a.identity === b.identity;

export async function freeTextRecipe(io: FreeTextIO, text: string): Promise<FreeTextResult> {
  let first: FreeTextRow | null;
  try {
    first = await io.read();
  } catch (err) {
    return { status: "error", error: `herdr read failed: ${(err as Error).message}` };
  }
  if (!first || !first.typeable) return { status: "changed" };

  if (!first.ready) {
    const opened = await io.send(first.openKeys);
    if (opened.status !== "sent") return opened;
    const ready = await pollModel(io, first, (m) => sameRow(m, first) && m.ready && m.text === "", sameRow);
    if (ready === "drifted") return { status: "changed" };
    if (ready === "timeout") return { status: "error", error: "The answer box did not open. Check the Terminal tab." };
  }

  const typed = await io.type(text);
  if (typed.status !== "sent") return typed;
  const landed = await pollModel(io, first, (m) => sameRow(m, first) && m.ready && norm(m.text) === norm(text), sameRow);
  if (landed !== "ok") {
    return {
      status: "error",
      error: "Your answer was typed but did not show in the dialog, so it was not sent. Check the Terminal tab.",
      typed: true,
    };
  }
  const submitted = await io.send(first.submitKeys);
  return submitted.status === "sent" ? { status: "sent", typed: true } : { ...submitted, typed: true };
}
