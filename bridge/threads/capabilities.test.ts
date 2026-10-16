import { describe, expect, test } from "bun:test";

import { AGENTS, capabilitiesFor, SHELL_CAPABILITIES } from "../../shared/agents.ts";
import { NO_CAPABILITIES, type ThreadCapabilities } from "../../shared/v2/contracts.ts";
import { composerFor } from "../../web/src/lib/harness/composer-kit.ts";

// The capability table (T08). Each row is what a thread of that harness may be asked to do live; a
// flag turns on only after a live check, so this pins the table as it was verified.

type Row = Pick<
  ThreadCapabilities,
  "canInterrupt" | "canSwitchPermissionMode" | "canSwitchModel" | "canSetEffortLive" | "hasJournal" | "resumeBySession" | "launchModes"
>;

const TABLE: Record<string, Row> = {
  claude: { canInterrupt: true, canSwitchPermissionMode: true, canSwitchModel: false, canSetEffortLive: false, hasJournal: true, resumeBySession: true, launchModes: true },
  pi: { canInterrupt: false, canSwitchPermissionMode: false, canSwitchModel: false, canSetEffortLive: false, hasJournal: true, resumeBySession: true, launchModes: true },
  grok: { canInterrupt: false, canSwitchPermissionMode: false, canSwitchModel: false, canSetEffortLive: false, hasJournal: true, resumeBySession: true, launchModes: true },
  cursor: { canInterrupt: false, canSwitchPermissionMode: false, canSwitchModel: false, canSetEffortLive: false, hasJournal: true, resumeBySession: false, launchModes: false },
  agy: { canInterrupt: false, canSwitchPermissionMode: false, canSwitchModel: false, canSetEffortLive: false, hasJournal: false, resumeBySession: false, launchModes: true },
  codex: { canInterrupt: false, canSwitchPermissionMode: false, canSwitchModel: false, canSetEffortLive: false, hasJournal: true, resumeBySession: true, launchModes: false },
};

describe("capabilitiesFor (shared/agents.ts)", () => {
  test("covers every descriptor", () => {
    expect(Object.keys(TABLE).sort()).toEqual(AGENTS.map((a) => a.id).sort());
  });

  test.each(Object.entries(TABLE))("%s matches the table", (id, row) => {
    expect(capabilitiesFor(id)).toMatchObject(row);
  });

  test.each(AGENTS.map((a) => [a.id, a] as const))("%s: hasJournal is journal !== undefined", (id, agent) => {
    expect(capabilitiesFor(id).hasJournal).toBe("journal" in agent && agent.journal !== undefined);
  });

  test("every agent can take a queued message; a shell or an unknown id gets the all-false record", () => {
    for (const a of AGENTS) expect(capabilitiesFor(a.id).canQueueDrain).toBe(true);
    expect(SHELL_CAPABILITIES).toEqual(NO_CAPABILITIES);
    expect(capabilitiesFor("shell")).toEqual(NO_CAPABILITIES);
    expect(capabilitiesFor("gemini")).toEqual(NO_CAPABILITIES);
    expect(Object.values(NO_CAPABILITIES).every((v) => v === false)).toBe(true);
  });

  test("interrupt keys only with canInterrupt; Claude's is the verified Escape", () => {
    expect(capabilitiesFor("claude").interruptKeys).toEqual(["Escape"]);
    for (const a of AGENTS) {
      const caps = capabilitiesFor(a.id);
      if (!caps.canInterrupt) expect(caps.interruptKeys).toBeUndefined();
    }
  });

  test("a mode switch needs a mode list and a footer reader; a model switch needs its command", () => {
    for (const a of AGENTS) {
      const caps = capabilitiesFor(a.id);
      if (caps.canSwitchPermissionMode) {
        expect(caps.permissionModes?.length ?? 0).toBeGreaterThan(0);
        expect(typeof composerFor(a.id)?.permissionModeOf).toBe("function");
        // Every listed mode is one the launch table knows.
        const ids = (("launch" in a ? a.launch : undefined) as { modes?: readonly { id: string }[] } | undefined)?.modes?.map((m) => m.id) ?? [];
        for (const m of caps.permissionModes ?? []) expect(ids).toContain(m);
      }
      if (caps.canSwitchModel) expect(caps.modelCommand).toMatch(/^\/\w+$/);
      if (caps.canSetEffortLive) expect(caps.effortCommand).toMatch(/^\/\w+$/);
    }
    expect(capabilitiesFor("claude")).toMatchObject({
      permissionModes: ["manual", "acceptEdits", "plan", "auto", "bypassPermissions"],
      modelCommand: "/model",
      effortCommand: "/effort",
    });
  });

  test("a thread's record does not share arrays with the table", () => {
    const a = capabilitiesFor("claude");
    a.permissionModes!.push("x");
    expect(capabilitiesFor("claude").permissionModes).not.toContain("x");
  });
});
