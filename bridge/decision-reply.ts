export type SpawnRunner = (
  cmd: string[],
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

export const defaultSpawnRunner: SpawnRunner = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
};

export interface SubmitDecisionReplyArgs {
  thread: string;
  payload: object | string;
  schema?: string;
  runner?: SpawnRunner;
  whistlrBin?: string;
}

export async function submitDecisionReply(
  args: SubmitDecisionReplyArgs,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const {
    thread,
    payload,
    schema = "whistlr.decision_response.v1",
    runner = defaultSpawnRunner,
    whistlrBin = "whistlr",
  } = args;

  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  const cmd = [
    whistlrBin,
    "reply",
    "--thread",
    thread,
    "--payload",
    payloadStr,
    "--schema",
    schema,
  ];

  try {
    const res = await runner(cmd);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr?.trim() || `whistlr exited with code ${res.exitCode}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
