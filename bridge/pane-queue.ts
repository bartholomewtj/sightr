/**
 * Per-pane write queue. Two writes to the same pane must not interleave: a reply is text -> 350 ms ->
 * Enter as two separate herdr RPCs, so a keys request landing in the gap submits half-typed text.
 * Each pane key owns a promise chain; a write waits its turn, runs, then releases. Panes are
 * independent — there is deliberately no global lock, because one slow pane must not stall the herd.
 */
export const PANE_QUEUE_TIMEOUT_MS = 10_000;

/** Thrown to the caller that gave up waiting. The route turns this into a 503, never a hang. */
export class PaneBusyError extends Error {
  constructor(key: string) {
    super(`pane busy: ${key}`);
    this.name = "PaneBusyError";
  }
}

/** The queue key for a pane: one bridge fronts one herdr, so the pane id alone is the identity. */
export function paneKey(paneId: string): string {
  return paneId;
}

export interface PaneQueue {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  size(): number;
}

export function createPaneQueue(timeoutMs: number = PANE_QUEUE_TIMEOUT_MS): PaneQueue {
  const tails = new Map<string, Promise<void>>();

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    const done = () => {
      release();
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
    };
    try {
      await waitTurn(prev, timeoutMs, key);
    } catch (err) {
      done();
      throw err;
    }
    try {
      return await fn();
    } finally {
      done();
    }
  }

  return { run, size: () => tails.size };
}

function waitTurn(prev: Promise<void>, timeoutMs: number, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PaneBusyError(key)), timeoutMs);
    prev.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
