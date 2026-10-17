// A new service worker reloads the page (lib/pwa.ts). On a phone that must not eat a half-typed message
// or yank the terminal out from under direct typing, so the reload waits until the operator is not
// mid-entry: a text field holding text has focus, or direct typing is armed. It goes ahead as soon as
// that stops, the page is hidden (nothing to interrupt), or {@link RELOAD_DEFER_MAX_MS} has passed
// (drafts persist, and an update must not wait forever behind an idle field).

export const RELOAD_DEFER_MAX_MS = 120_000;
export const RELOAD_RECHECK_MS = 1_000;

export interface IdleDeps {
  document: Pick<Document, "activeElement" | "visibilityState" | "querySelector" | "addEventListener" | "removeEventListener">;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const browserIdleDeps = (): IdleDeps => ({
  document,
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
});

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"]);

/** The operator is part-way through typing something a reload would lose or interrupt. */
export function isMidEntry(doc: IdleDeps["document"]): boolean {
  if (doc.querySelector('[data-direct-typing="armed"]')) return true;
  const el = doc.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return el.value.length > 0;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type) && el.value.length > 0;
  return el.isContentEditable && (el.textContent ?? "").length > 0;
}

/** Run `reload` now, or once the operator stops typing (see the header). Returns a cancel function. */
export function reloadWhenIdle(reload: () => void, deps: IdleDeps = browserIdleDeps()): () => void {
  const doc = deps.document;
  const ready = () => doc.visibilityState === "hidden" || !isMidEntry(doc);
  if (ready()) {
    reload();
    return () => {};
  }
  const since = deps.now();
  let timer: unknown = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer !== null) deps.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", check);
    reload();
  };
  function check(): void {
    if (done) return;
    if (ready() || deps.now() - since >= RELOAD_DEFER_MAX_MS) finish();
  }
  const tick = () => {
    timer = null;
    check();
    if (!done) timer = deps.setTimeout(tick, RELOAD_RECHECK_MS);
  };
  doc.addEventListener("visibilitychange", check);
  timer = deps.setTimeout(tick, RELOAD_RECHECK_MS);
  return () => {
    done = true;
    if (timer !== null) deps.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", check);
  };
}
