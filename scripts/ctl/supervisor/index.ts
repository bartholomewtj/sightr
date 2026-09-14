import type { Run } from "../types.ts";
import type { Paths } from "../paths.ts";
import { taskSchedulerSupervisor } from "./taskscheduler.ts";

export interface ServiceSpec { paths: Paths; env: Record<string,string|undefined>; bun: string; port: string; socket: string; hosts: string; }
export interface Supervisor {
 readonly kind: "taskscheduler";
 describe(run: Run): Promise<string>;
 install(spec: ServiceSpec, run: Run): Promise<void>; enableNow(spec: ServiceSpec, run: Run): Promise<void>;
 disableNow(spec: ServiceSpec, run: Run): Promise<void>; remove(spec: ServiceSpec, run: Run): Promise<void>;
}
// Windows Task Scheduler is the only supervisor. Kept behind a selector so callers name the intent, not the mechanism.
export function selectSupervisor(env: Record<string,string|undefined> = process.env): Supervisor { return taskSchedulerSupervisor(env); }
