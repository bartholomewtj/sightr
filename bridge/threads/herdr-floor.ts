import type { HerdrClient } from "../herdr-client.ts";

// The herdr version v2 needs (decided with Bart, 16 Oct 2026: 0.9.0 for everything in v2). The bridge
// asks once; below the floor the v2 ingestors never start and every `/api/v2/*` route answers 503 with
// the reason, while v1 carries on as before.

export const HERDR_FLOOR = "0.9.0";

export type HerdrVersion = readonly [major: number, minor: number, patch: number];

/** The leading `major.minor.patch` of `s` (a `-preview…` or `+build` suffix is ignored), or null. */
export function parseHerdrVersion(s: string): HerdrVersion | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+.].*)?\s*$/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `s` is at or above `floor`. Anything unparseable (`"<0.7"`, garbage) is below it. */
export function meetsFloor(s: string, floor: string = HERDR_FLOOR): boolean {
  const have = parseHerdrVersion(s);
  const need = parseHerdrVersion(floor);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

export type V2GateState = "pending" | "ok" | "too-old";

export interface V2Gate {
  state(): V2GateState;
  /** Why v2 is not available, for the 503 body; empty once `ok`. */
  reason(): string;
  /** The version herdr reported, once a check succeeded. */
  version(): string | null;
  /**
   * Ask herdr for its version. Concurrent calls share one request. A failure to reach herdr leaves the
   * gate `pending` (the caller tries again when the link comes up); after one answer the result is
   * fixed for the life of the process, and later calls do nothing.
   */
  check(herdr: Pick<HerdrClient, "serverVersion">): Promise<void>;
  /** Run `fn` once the gate is `ok` (at once if it already is). Never runs below the floor. */
  whenOk(fn: () => void): void;
}

export function createV2Gate(opts: { floor?: string; log?: (msg: string) => void } = {}): V2Gate {
  const floor = opts.floor ?? HERDR_FLOOR;
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  let state: V2GateState = "pending";
  let reason = "v2 is starting: waiting for herdr to answer";
  let version: string | null = null;
  let inFlight: Promise<void> | null = null;
  const waiting: (() => void)[] = [];

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log(`[threads] v2 start-up step failed: ${(err as Error).message}`);
    }
  };

  const settle = (found: string) => {
    version = found;
    if (meetsFloor(found, floor)) {
      state = "ok";
      reason = "";
      for (const fn of waiting.splice(0)) run(fn);
    } else {
      state = "too-old";
      reason = `v2 needs herdr >= ${floor} (found ${found})`;
      waiting.length = 0;
      log(`[threads] ${reason}; v2 is off until herdr is upgraded and the bridge restarts`);
    }
  };

  return {
    state: () => state,
    reason: () => reason,
    version: () => version,
    check(herdr) {
      if (state !== "pending") return Promise.resolve();
      inFlight ??= (async () => {
        try {
          const found = await herdr.serverVersion();
          if (state === "pending") settle(found);
        } catch {
          // Unreachable: stay pending; index.ts checks again when the link comes up.
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    whenOk(fn) {
      if (state === "ok") run(fn);
      else if (state === "pending") waiting.push(fn);
    },
  };
}
