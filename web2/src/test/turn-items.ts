/** Turn item and run factories for the timeline tests (T11). Ids follow T03: `<entry key>:<part>`. */
import type { Run, TurnItem } from "@shared/v2/contracts";

type Base = Omit<TurnItem, "type">;

let ordinal = 0;
export function resetOrdinals(): void {
  ordinal = 0;
}

function base(id: string, over: Partial<Base> & { threadId?: string } = {}): Base {
  const at = over.createdAt ?? 1_000_000;
  return {
    id,
    threadId: "t1",
    runId: null,
    ordinal: ordinal++,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  } as Base;
}

export function user(id: string, text: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, over), type: "user_message", messageId: id.split(":")[0]!, text, attachments: [] } as TurnItem;
}

export function assistant(id: string, text: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, over), type: "assistant_message", messageId: id.split(":")[0]!, text, streaming: false } as TurnItem;
}

export function reasoning(id: string, text: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, over), type: "reasoning", text, streaming: false } as TurnItem;
}

export function command(id: string, input: string, over: Partial<Base> & { output?: string; exitCode?: number } = {}): TurnItem {
  const { output, exitCode, ...rest } = over;
  return {
    ...base(id, { title: "Bash", ...rest }),
    type: "command_execution",
    input,
    ...(output !== undefined ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  } as TurnItem;
}

export function edit(id: string, fileName: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, { title: "Edit", ...over }), type: "file_change", fileName } as TurnItem;
}

export function read(id: string, path: string, over: Partial<Base> & { output?: string } = {}): TurnItem {
  const { output, ...rest } = over;
  return {
    ...base(id, { title: "Read", ...rest }),
    type: "dynamic_tool",
    toolName: "Read",
    input: path,
    ...(output !== undefined ? { output } : {}),
  } as TurnItem;
}

export function session(id: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, over), type: "session", from: "old", to: "new" } as TurnItem;
}

export function screen(id: string, text: string, over: Partial<Base> = {}): TurnItem {
  return { ...base(id, over), type: "screen", text, capturedAt: over.createdAt ?? 1_000_000 } as TurnItem;
}

export function run(id: string, over: Partial<Run> = {}): Run {
  return { id, threadId: "t1", ordinal: 0, status: "completed", startedAt: 1_000_000, completedAt: 1_063_000, ...over };
}
