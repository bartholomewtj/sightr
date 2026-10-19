// Sightr code (T31). The per-project run-snapshot switch (T30's `project.checkpoints.set`) and what the client can tell of
// the bridge-wide kill switch. `SIGHTR_CHECKPOINTS=0` is not in any wire shape (T30 keeps it out of `Project.checkpoints`
// on purpose); its only trace is that every run reads `absent: disabled`. So "Off for this bridge" is inferred: the open
// thread's newest run says `disabled` while its project's own switch is not off. A thread that is not open says nothing,
// and a run begun before the operator turned a project back on can read it for a moment, which is why only the newest run counts.
import type { Project } from "@shared/v2/contracts";
import { showToast } from "@/components/toast";

import { defaultCommandDeps, sendCommand, V2CommandError } from "@/stream/commands";
import { useShell, useThreadStore } from "@/stream/stores";

/** Turn run snapshots on or off for one project. Later runs only. Not optimistic: the bridge's `project.upserted` redraws the switch. */
export async function setProjectCheckpoints(projectId: string, enabled: boolean): Promise<boolean> {
  try {
    await sendCommand("project.checkpoints.set", { projectId, enabled }, defaultCommandDeps());
    return true;
  } catch (err) {
    const reason = err instanceof V2CommandError ? (err.body?.error ?? err.code) : "the bridge did not answer";
    showToast(`Couldn't change run snapshots: ${reason}`, "error");
    return false;
  }
}

/** The switch as the project reports it: absent is the default, on. */
export const projectCheckpointsOn = (project: Pick<Project, "checkpoints">): boolean => project.checkpoints !== false;

/** True when the open thread's newest run was refused a snapshot as `disabled` although its project's switch is on. */
export function useBridgeCheckpointsOff(): boolean {
  const thread = useThreadStore((s) => s.current);
  const projects = useShell((s) => s.projects);
  if (!thread?.thread) return false;
  const runs = Object.values(thread.runs);
  if (runs.length === 0) return false;
  const newest = runs.reduce((a, b) => (b.ordinal > a.ordinal ? b : a));
  const project = projects[thread.thread.projectId];
  return newest.checkpoint?.status === "absent" && newest.checkpoint.reason === "disabled" && (project === undefined || projectCheckpointsOn(project));
}
