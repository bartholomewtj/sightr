import { join } from "node:path";

import { CONN_LOG_FILENAME, type BridgeEvent, type PhoneEvent } from "../shared/conn.ts";
import { fileAuditAppender, type AppendFn } from "./audit.ts";

// Connection telemetry trail: `<stateDir>/conn.log`, one JSON line per event, read back by
// `sightr-ctl conn`. Same size cap and single rotated generation as audit.log (it reuses that
// appender). Timings and enums only — see shared/conn.ts. Like the audit trail, a failed write is
// logged and swallowed: telemetry must never fail the request that carried it.

export class ConnLog {
  constructor(
    private readonly append: AppendFn | null,
    private readonly now: () => number = Date.now,
  ) {}

  enabled(): boolean {
    return this.append !== null;
  }

  bridge(event: BridgeEvent): void {
    this.write({ ts: this.stamp(), src: "bridge", ...event });
  }

  phone(event: PhoneEvent, device: string | null): void {
    this.write({ ts: this.stamp(), src: "phone", ...(device ? { device } : {}), ...event });
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private write(line: object): void {
    if (!this.append) return;
    try {
      void Promise.resolve(this.append(`${JSON.stringify(line)}\n`)).catch((err) =>
        console.warn(`[conn] could not write: ${(err as Error).message}`),
      );
    } catch (err) {
      console.warn(`[conn] could not write: ${(err as Error).message}`);
    }
  }
}

export const SILENT_CONN = new ConnLog(null);

export function createConnLog(opts: { stateDir: string; enabled: boolean }): ConnLog {
  return opts.enabled ? new ConnLog(fileAuditAppender(join(opts.stateDir, CONN_LOG_FILENAME))) : SILENT_CONN;
}
