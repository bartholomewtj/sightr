import { ADAPTER_AGENTS, adapterFor } from "./registry";
import { KIT_AGENTS, composerFor } from "./composer-kit";

// The bridge runs the reply guard on the kit; the browser's adapters render the same screens. If the
// two ever held different functions, the bridge and the phone could judge one screen two ways.
const FIELDS = [
  "composerReady",
  "submitHeld",
  "extractInputDraft",
  "composerPrompt",
  "unbindableComposer",
  "draftCarriesSend",
  "bracketedPaste",
  "replyOneShot",
  "permissionModeOf",
  "defaultModeId",
] as const;

describe("composer kit", () => {
  it("covers exactly the agents that have adapters", () => {
    expect([...KIT_AGENTS].sort()).toEqual([...ADAPTER_AGENTS].sort());
  });

  it.each([...ADAPTER_AGENTS])("%s: every field is the adapter's own", (agent) => {
    const adapter = adapterFor(agent)!;
    const kit = composerFor(agent)!;
    for (const field of FIELDS) expect(kit[field], `${agent}.${field}`).toBe(adapter[field]);
    expect(kit.submitKeys).toEqual(adapter.submitKeys);
  });

  it("matches the agent string exactly", () => {
    expect(composerFor("claude-code")).toBeUndefined();
    expect(composerFor("constructor")).toBeUndefined();
    expect(composerFor(undefined)).toBeUndefined();
    expect(composerFor(null)).toBeUndefined();
  });
});
