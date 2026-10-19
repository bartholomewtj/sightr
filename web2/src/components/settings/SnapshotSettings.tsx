// Settings → Run snapshots (T31): one row per open project, "Take run snapshots in <project>", writing T30's
// `project.checkpoints.set`. The bridge snapshots a thread's folder when each run starts and ends, so a run's diff can be
// exact; the snapshots live in a private copy under Sightr's own folder and nothing is written into the repository. The
// switch is per project and bridge-wide, so every device sees the same state; a read-only device sees it disabled.
import { useState } from "react";

import { Switch } from "~/components/ui/switch";
import { projectCheckpointsOn, setProjectCheckpoints, useBridgeCheckpointsOff } from "@/state/checkpoints";
import { useShell } from "@/stream/stores";

import { SettingsRow } from "./settingsLayout";

const WHAT_CHANGES =
  "Exact run diffs, kept in a private copy under Sightr's own folder; nothing is written into your repository. Turning it off affects later runs only: snapshots already taken stay until they expire.";

export function SnapshotSettings({ readOnly }: { readOnly: boolean }) {
  const projects = useShell((s) => s.projects);
  const bridgeOff = useBridgeCheckpointsOff();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const list = Object.values(projects)
    .filter((p) => p.closedAt === undefined)
    .sort((a, b) => a.order - b.order);

  const toggle = async (projectId: string, enabled: boolean) => {
    setBusy((prev) => new Set(prev).add(projectId));
    await setProjectCheckpoints(projectId, enabled);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
  };

  if (list.length === 0) {
    return <SettingsRow title="Run snapshots" description="No projects yet. Each project gets its own switch once it has a workspace." />;
  }
  return (
    <>
      {list.map((project) => (
        <SettingsRow
          key={project.id}
          title={`Take run snapshots in ${project.label}`}
          description={bridgeOff ? "Snapshots are switched off for the whole bridge (SIGHTR_CHECKPOINTS=0 on the host)." : WHAT_CHANGES}
          disabled={readOnly || bridgeOff}
          data-snapshot-project={project.id}
          control={
            bridgeOff ? (
              <span className="text-xs text-muted-foreground" data-snapshot-bridge-off="">
                Off for this bridge
              </span>
            ) : (
              <Switch
                checked={projectCheckpointsOn(project)}
                disabled={readOnly || busy.has(project.id)}
                onCheckedChange={(next) => void toggle(project.id, next)}
                aria-label={`Take run snapshots in ${project.label}`}
              />
            )
          }
        />
      ))}
    </>
  );
}
