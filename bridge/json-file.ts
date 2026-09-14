import { mkdir, rename as renameFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteJsonOptions {
  indent?: number;
  rename?: (from: string, to: string) => Promise<void>;
}

export async function writeJsonAtomic(file: string, value: unknown, opts: WriteJsonOptions = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, opts.indent ?? 0), { mode: 0o600 });
  try {
    await (opts.rename ?? renameFile)(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return await Bun.file(file).json() as T; } catch { return fallback; }
}
