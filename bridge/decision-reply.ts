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
  /** Human text. Contract 2 requires `--text` as well as `--thread`. */
  text: string;
  payload: object | string;
  schema?: string;
  runner?: SpawnRunner;
  whistlrBin?: string;
}

export type DecisionReplyResult =
  | { ok: true; id: string; reply: Record<string, unknown> }
  | { ok: false; error: string };

export async function submitDecisionReply(
  args: SubmitDecisionReplyArgs,
): Promise<DecisionReplyResult> {
  const {
    thread,
    text,
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
    "--text",
    text,
    "--payload",
    payloadStr,
    "--schema",
    schema,
    "--json",
  ];

  try {
    const res = await runner(cmd);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr?.trim() || `whistlr exited with code ${res.exitCode}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout ?? "");
    } catch {
      return { ok: false, error: "whistlr reply was not JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "whistlr reply was not JSON" };
    }
    const reply = parsed as Record<string, unknown>;
    if (reply.ok === false) {
      const detail = typeof reply.error === "string" ? reply.error : "whistlr reply refused";
      return { ok: false, error: detail };
    }
    if (typeof reply.id !== "string" || reply.id.length === 0) {
      return { ok: false, error: "whistlr reply had no id" };
    }
    return { ok: true, id: reply.id, reply };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
