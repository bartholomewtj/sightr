import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BEACON_HOOKS } from "../beacon-emit.ts";
import { resolveBun } from "./bun.ts";
import { effectiveEnv } from "./env.ts";
import { pluginRoot } from "./paths.ts";
import { realRun, type Run } from "./types.ts";

// `hooks install claude` / `uninstall claude` / `status` — putting the beacon emitter into Claude's
// own settings, and taking it back out.
//
// ── THE SCOPE IS GLOBAL, AND THAT IS THE POINT ───────────────────────────────────────────────────
//
// The targets are `%USERPROFILE%\.claude\settings.json` and the same file in every profile
// `SIGHTR_CLAUDE_ROOT` names. PROJECT SETTINGS ARE NEVER WRITTEN — not `.claude/settings.json`, not
// `.claude/settings.local.json`. The operator adopts panes anywhere on the host, so a per-project
// install would make a pane's identity depend on which directory the agent happened to be started
// in, which is precisely the fragility beacons exist to remove.
//
// ── THREE GUARDS ─────────────────────────────────────────────────────────────────────────────────
//
//  1. MERGE BY A VERSION-PREFIXED OWNERSHIP MARKER. Claude Code merges hook entries across settings
//     levels rather than replacing them, so an operator's own hooks sit in the same arrays as ours.
//     Every entry we write carries {@link HOOK_MARKER}; an entry without one is never touched, read
//     or reordered, and `uninstall` removes only marked entries. A marker at a DIFFERENT version is
//     replaced IN PLACE — that is the self-heal, and it is why the version is in the marker at all.
//  2. REFUSE A SYMLINKED SETTINGS FILE. Writing through one is how an installer edits a file the
//     operator did not mean — and the temp-plus-rename below would REPLACE the link rather than
//     follow it, which is worse than a plain overwrite. A symlinked (or junctioned) config DIRECTORY
//     is a different thing: relocating `~/.claude` with a junction is an ordinary Windows layout and
//     is exactly what the operator meant, so the directory is resolved once and the real file inside
//     it is what gets checked and written.
//  3. WRITE ATOMICALLY, AND BACK UP ONCE. Temp file plus rename, and a `.sightr-backup` beside the
//     file before the first modification, so a bad merge is one copy away from undone.
//
// Installing twice changes no bytes: the result is serialised and COMPARED TO WHAT WAS READ, and an
// equal document is not written at all. "Already installed" is never decided by finding a marker and
// stopping — so when a registration joins BEACON_HOOKS, the next install adds that one event to a
// file that already carries the others and leaves every entry beside it where it was.

/** The harnesses that have an emitter. One today; the argument is required so a second needs no verb. */
export const HOOK_HARNESSES = ["claude"] as const;

/** Bumped when the COMMAND's shape changes — not when the set of events grows. */
export const HOOK_MARKER_VERSION = 1;
export const HOOK_MARKER_PREFIX = "# sightr-beacon v";
export const HOOK_MARKER = `${HOOK_MARKER_PREFIX}${HOOK_MARKER_VERSION}`;
/** How long Claude waits for the emitter before giving up on it. */
const HOOK_TIMEOUT_SECONDS = 10;

const BACKUP_SUFFIX = ".sightr-backup";
const TEMP_SUFFIX = ".sightr-tmp";

/** One settings file we may write, and the directory holding it. */
export interface HookTarget {
  readonly dir: string;
  readonly path: string;
}

/**
 * Every Claude profile on this host: the default one, plus one per `SIGHTR_CLAUDE_ROOT` entry.
 *
 * That variable names `.../projects` directories (it is how the journal finds session logs), so the
 * profile's config dir is its parent. De-duplicated, because a profile that repeats the default is
 * the same file and must not be written twice.
 */
export function claudeSettingsTargets(
  home: string,
  env: Record<string, string | undefined>,
): HookTarget[] {
  const dirs = new Set<string>([path.join(home, ".claude")]);
  for (const entry of (env.SIGHTR_CLAUDE_ROOT ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) dirs.add(path.dirname(trimmed));
  }
  return [...dirs].map((dir) => ({ dir, path: path.join(dir, "settings.json") }));
}

/** The marker's version inside a command string, or null when it carries none of ours. */
export function markerVersionOf(command: string): number | null {
  const match = new RegExp(`${HOOK_MARKER_PREFIX}(\\d+)`).exec(command);
  return match === null ? null : Number(match[1]);
}

/**
 * The command Claude runs for one event.
 *
 * Both paths are quoted so a space in either works under `cmd.exe` and under `sh`, and the absolute
 * path of the running bun is written in so the hook never depends on Claude's own PATH.
 */
export function hookCommand(bun: string, script: string, event: string): string {
  return `"${bun}" "${script}" ${event} ${HOOK_MARKER}`;
}

/** The marked command inside one hook group, or null when the group is not ours. */
export function markedCommandIn(group: unknown): string | null {
  if (typeof group !== "object" || group === null || Array.isArray(group)) return null;
  const hooks = (group as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return null;
  for (const hook of hooks) {
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) continue;
    const command = (hook as Record<string, unknown>).command;
    if (typeof command === "string" && markerVersionOf(command) !== null) return command;
  }
  return null;
}

/** Per registration, the marked command already in the document — or null where there is none. */
export function markedCommandsByEvent(document: unknown): (string | null)[] {
  const hooks =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>).hooks
      : undefined;
  const byEvent =
    typeof hooks === "object" && hooks !== null && !Array.isArray(hooks)
      ? (hooks as Record<string, unknown>)
      : {};
  return BEACON_HOOKS.map((registration) => {
    const groups = byEvent[registration.event];
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      const command = markedCommandIn(group);
      if (command !== null) return command;
    }
    return null;
  });
}

/** What an install or uninstall decided: a document to write, or a refusal to explain. */
export type HookDocument =
  | { kind: "document"; document: Record<string, unknown> }
  | { kind: "refuse"; reason: string };

function ourGroup(registration: (typeof BEACON_HOOKS)[number], command: string): Record<string, unknown> {
  return {
    // `undefined` keys are dropped by JSON.stringify — that is how "every occurrence" is written.
    ...(registration.matcher === undefined ? {} : { matcher: registration.matcher }),
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
  };
}

type Refusal = { refuse: string };

function readDocument(current: unknown): Record<string, unknown> | Refusal {
  if (current === null || current === undefined) return {};
  if (typeof current !== "object" || Array.isArray(current)) {
    return { refuse: "its top level is not a JSON object" } satisfies Refusal;
  }
  return { ...(current as Record<string, unknown>) };
}

function isRefusal(value: Record<string, unknown> | Refusal): value is Refusal {
  return typeof (value as Refusal).refuse === "string";
}

/**
 * The document with our five entries in it.
 *
 * An unmarked entry is never touched, read or reordered. A marked entry at a different version is
 * replaced at its own index, so re-running install after a version change heals the file without
 * moving anybody's hooks around.
 */
export function installDocument(current: unknown, bun: string, script: string): HookDocument {
  const read = readDocument(current);
  if (isRefusal(read)) return { kind: "refuse", reason: read.refuse };
  const document = read;

  const rawHooks = document.hooks;
  if (rawHooks !== undefined && (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks))) {
    return { kind: "refuse", reason: "its `hooks` is not a JSON object" };
  }
  const hooks: Record<string, unknown> = { ...((rawHooks as Record<string, unknown>) ?? {}) };

  for (const registration of BEACON_HOOKS) {
    const existing = hooks[registration.event];
    if (existing !== undefined && !Array.isArray(existing)) {
      return { kind: "refuse", reason: `its \`hooks.${registration.event}\` is not an array` };
    }
    const groups = [...((existing as unknown[]) ?? [])];
    const group = ourGroup(registration, hookCommand(bun, script, registration.event));
    const at = groups.findIndex((row) => markedCommandIn(row) !== null);
    if (at === -1) groups.push(group);
    else groups[at] = group; // in place: the operator's neighbours keep their indices
    hooks[registration.event] = groups;
  }

  document.hooks = hooks;
  return { kind: "document", document };
}

/** The document with only OUR entries removed — an event array or a `hooks` left empty is dropped. */
export function uninstallDocument(current: unknown): HookDocument {
  const read = readDocument(current);
  if (isRefusal(read)) return { kind: "refuse", reason: read.refuse };
  const document = read;

  const rawHooks = document.hooks;
  if (rawHooks === undefined) return { kind: "document", document };
  if (typeof rawHooks !== "object" || rawHooks === null || Array.isArray(rawHooks)) {
    return { kind: "refuse", reason: "its `hooks` is not a JSON object" };
  }
  const hooks: Record<string, unknown> = { ...(rawHooks as Record<string, unknown>) };

  for (const registration of BEACON_HOOKS) {
    const groups = hooks[registration.event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((row) => markedCommandIn(row) === null);
    if (kept.length === 0) delete hooks[registration.event];
    else hooks[registration.event] = kept;
  }

  if (Object.keys(hooks).length === 0) delete document.hooks;
  else document.hooks = hooks;
  return { kind: "document", document };
}

/** Two spaces and a trailing newline — what an editor would leave behind. */
export function serializeSettings(document: object): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** What one target is, before anything is written. */
export type TargetState =
  | { kind: "symlink" }
  | { kind: "unreadable" }
  | { kind: "absent" }
  | { kind: "read"; text: string; document: unknown };

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false; // absent is not a symlink
  }
}

/** Read a target without writing anything — the shared first half of install, uninstall and status. */
export async function readTarget(target: HookTarget): Promise<{ state: TargetState; target: HookTarget }> {
  // Follow a junctioned config directory ONCE, deliberately, and then work on the real file inside
  // it — see guard 2. A directory that cannot be resolved (it does not exist yet) keeps its path.
  let dir = target.dir;
  try {
    dir = await realpath(target.dir);
  } catch {
    // Nothing to resolve; the install will create the file at the path as given.
  }
  const resolved: HookTarget = { dir, path: path.join(dir, "settings.json") };
  if (await isSymlink(resolved.path)) return { state: { kind: "symlink" }, target: resolved };
  let text: string;
  try {
    text = await readFile(resolved.path, "utf8");
  } catch {
    return { state: { kind: "absent" }, target: resolved };
  }
  try {
    return { state: { kind: "read", text, document: JSON.parse(text) }, target: resolved };
  } catch {
    return { state: { kind: "unreadable" }, target: resolved };
  }
}

/** Write `text` to the target atomically, taking a one-time backup of what was there. */
async function writeTarget(target: HookTarget, text: string, hadFile: boolean): Promise<void> {
  if (hadFile) {
    const backup = `${target.path}${BACKUP_SUFFIX}`;
    try {
      await lstat(backup);
    } catch {
      // Only when there is not one already: a second install must never clobber the original.
      await writeFile(backup, await readFile(target.path, "utf8"), { mode: 0o600 });
    }
  }
  const temp = `${target.path}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await rename(temp, target.path);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

function symlinkError(target: HookTarget): string {
  return (
    `error: ${target.path} is a symlink — refusing to write through it.\n` +
    `  Replace it with the real file or directory (or point the profile at the real one),\n` +
    "  then re-run `hooks install claude`."
  );
}

async function applyToTargets(
  targets: HookTarget[],
  decide: (current: unknown) => HookDocument,
  verb: "install" | "uninstall",
): Promise<number> {
  let failed = false;
  for (const requested of targets) {
    const { state, target } = await readTarget(requested);
    if (state.kind === "symlink") {
      console.error(symlinkError(target));
      failed = true;
      continue;
    }
    if (state.kind === "unreadable") {
      console.error(`error: ${target.path} is not valid JSON — fix it, then re-run.`);
      failed = true;
      continue;
    }
    if (state.kind === "absent" && verb === "uninstall") {
      console.log(`${target.path} — no settings file, nothing to remove.`);
      continue;
    }

    const decided = decide(state.kind === "read" ? state.document : null);
    if (decided.kind === "refuse") {
      console.error(`error: ${target.path} was left alone — ${decided.reason}.`);
      failed = true;
      continue;
    }
    const text = serializeSettings(decided.document);
    if (state.kind === "read" && text === state.text) {
      console.log(`${target.path} already has them — no bytes changed.`);
      continue;
    }
    try {
      await writeTarget(target, text, state.kind === "read");
      console.log(`${target.path} — ${verb === "install" ? "installed" : "removed"}.`);
    } catch (err) {
      console.error(`error: could not write ${target.path}: ${String(err)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/** One line per target, and never a byte written. */
async function reportStatus(targets: HookTarget[], bun: string, script: string, check: boolean): Promise<number> {
  console.log(`would install: ${bun} ${script}`);
  let behind = false;
  for (const requested of targets) {
    const { state, target } = await readTarget(requested);
    if (state.kind === "symlink") {
      console.log(`${target.path}: refused — it is a symlink`);
      continue;
    }
    if (state.kind === "unreadable") {
      console.log(`${target.path}: unreadable — not valid JSON`);
      continue;
    }
    if (state.kind === "absent") {
      console.log(`${target.path}: no settings file — \`hooks install claude\` creates one`);
      continue;
    }
    const commands = markedCommandsByEvent(state.document);
    const present = commands.filter((command): command is string => command !== null);
    if (present.length === 0) {
      console.log(`${target.path}: not installed`);
      continue;
    }
    const versions = new Set(present.map((command) => markerVersionOf(command)));
    const stale = [...versions].some((version) => version !== HOOK_MARKER_VERSION);
    if (present.length < commands.length) {
      behind = true;
      console.log(
        `${target.path}: partly installed (v${[...versions].join("/")}, ${present.length}/${commands.length} events)` +
          " — re-run install to add the rest",
      );
      continue;
    }
    if (stale) {
      behind = true;
      console.log(`${target.path}: installed at v${[...versions].join("/")} — re-run install to heal it to v${HOOK_MARKER_VERSION}`);
      continue;
    }
    console.log(`${target.path}: installed (v${HOOK_MARKER_VERSION})`);
  }
  // Exit 2, distinct from the 1 a write failure gives, so a script can tell "behind" from "broken".
  return check && behind ? 2 : 0;
}

const USAGE = [
  "usage: hooks install {claude}",
  "       hooks uninstall {claude}",
  "       hooks status [--check]",
].join("\n");

/** `hooks <sub-verb> [...]`. Exit 0 on success, 1 when a target failed, 2 on misuse. */
export async function hooks(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  run: Run = realRun,
): Promise<number> {
  const sub = args[0];
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    console.error(USAGE);
    return 2;
  }

  const { effective } = await effectiveEnv(env, run);
  const home = effective.USERPROFILE ?? effective.HOME ?? os.homedir();
  const targets = claudeSettingsTargets(home, effective);
  const script = path.join(pluginRoot, "scripts", "beacon-emit.ts");

  if (sub === "status") {
    const bun = await resolveBun(effective);
    return reportStatus(targets, bun || "bun", script, args.includes("--check"));
  }

  const harness = args[1];
  if (harness === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (!(HOOK_HARNESSES as readonly string[]).includes(harness)) {
    console.error(`usage: hooks ${sub} {claude}`);
    console.error(`\`${harness}\` has no beacon emitter — only claude does.`);
    return 2;
  }

  if (sub === "uninstall") return applyToTargets(targets, uninstallDocument, "uninstall");

  const bun = await resolveBun(effective);
  if (!bun) {
    console.error("error: could not find bun.exe — install Bun, or set BUN_INSTALL, then re-run.");
    return 1;
  }
  return applyToTargets(targets, (current) => installDocument(current, bun, script), "install");
}
