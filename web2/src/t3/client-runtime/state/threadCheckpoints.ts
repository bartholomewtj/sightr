// Pattern from T3 Code packages/client-runtime/src/state/threadCheckpoints.ts @ db5919d87daf (MIT, see THIRD_PARTY.md).
// T3's `deriveThreadCheckpointSummaries` folds a thread projection's checkpoints into one summary per run
// (checkpoint id, run id, `appRunOrdinal` as the turn count, status, files, the run's last assistant message,
// `completedAt`), newest last, and skips a checkpoint with no run. Sightr's runs carry their checkpoint
// (`Run.checkpoint`, T30), so this is the same fold over runs: plain functions, no Effect or branded ids, ordered
// by `Run.ordinal`, a run with no checkpoint absent from the map. Not taken: the assistant message id (the card
// sits under the run's reply by the timeline's own placement), `checkpointRef` (a ref or sha never reaches a
// client) and the ISO `completedAt` (epoch ms here).
import type { CheckpointFile, Run, RunCheckpoint } from "@shared/v2/contracts";

export interface RunCheckpointSummary {
  readonly runId: string;
  /** The run's ordinal in its thread (T3's `checkpointTurnCount`). */
  readonly ordinal: number;
  readonly status: RunCheckpoint["status"];
  readonly reason?: RunCheckpoint["reason"];
  /** The snapshot objects are still in the bridge's store. `live` absent is read as live; only `false` is expired. */
  readonly live: boolean;
  readonly files: ReadonlyArray<CheckpointFile>;
  readonly additions: number;
  readonly deletions: number;
  readonly capturedAt?: number;
  readonly checkpoint: RunCheckpoint;
}

type RunLike = Pick<Run, "id" | "ordinal" | "checkpoint">;

/**
 * One summary per run that has a checkpoint, in run order (oldest first, newest last, as T3's list). A
 * checkpoint for a run that is not in `runs` (pruned, or not loaded) is dropped. `checkpointByRun` holds
 * checkpoints that arrived apart from the run (T3 reads its projection's list); where both exist it wins.
 */
export function deriveRunCheckpointSummaries(
  runs: ReadonlyArray<RunLike> | Readonly<Record<string, RunLike>>,
  checkpointByRun?: ReadonlyMap<string, RunCheckpoint> | Readonly<Record<string, RunCheckpoint>>,
): Map<string, RunCheckpointSummary> {
  const list = Array.isArray(runs) ? (runs as ReadonlyArray<RunLike>) : Object.values(runs as Readonly<Record<string, RunLike>>);
  const lookup = (id: string): RunCheckpoint | undefined =>
    checkpointByRun instanceof Map ? checkpointByRun.get(id) : (checkpointByRun as Readonly<Record<string, RunCheckpoint>> | undefined)?.[id];
  const out = new Map<string, RunCheckpointSummary>();
  const ordered = [...list].sort((a, b) => a.ordinal - b.ordinal);
  for (const run of ordered) {
    const checkpoint = lookup(run.id) ?? run.checkpoint;
    if (!checkpoint) continue;
    out.set(run.id, {
      runId: run.id,
      ordinal: run.ordinal,
      status: checkpoint.status,
      ...(checkpoint.reason === undefined ? {} : { reason: checkpoint.reason }),
      live: checkpoint.live !== false,
      files: checkpoint.files,
      additions: checkpoint.additions,
      deletions: checkpoint.deletions,
      ...(checkpoint.capturedAt === undefined ? {} : { capturedAt: checkpoint.capturedAt }),
      checkpoint,
    });
  }
  return out;
}
