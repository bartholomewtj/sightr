export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[], opts?: {
  cwd?: string; env?: Record<string, string>; timeoutMs?: number;
  stdio?: "inherit" | "pipe";
}) => Promise<RunResult>;

export class CtlError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

export const realRun: Run = async (cmd, args, opts = {}) => {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdout: opts.stdio === "inherit" ? "inherit" : "pipe",
      stderr: opts.stdio === "inherit" ? "inherit" : "pipe",
    });
    const timer = opts.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : undefined;
    const stdout = opts.stdio === "inherit" ? "" : await new Response(proc.stdout).text();
    const stderr = opts.stdio === "inherit" ? "" : await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: String(error) };
  }
};
