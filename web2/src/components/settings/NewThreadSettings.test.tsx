import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { pickersFor } from "@/components/new-thread/NewThread.logic";
import { ProviderModelPicker } from "@/components/chat/ProviderModelPicker";
import { setDraftHarness, useDraftThread } from "@/state/draft-thread";
import { getThreadDefaults } from "@/state/thread-defaults";

import { NewThreadSettings } from "./NewThreadSettings";

const H = "claude";
const models = pickersFor(H).models!;
const bypassLabel = pickersFor(H).modes!.find((m) => m.destructive)!.label;
const radio = (group: string, name: string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

describe("Settings → New threads", () => {
  it("picks the harness a project with no history opens on, or asks each time", () => {
    render(<NewThreadSettings />);
    expect(radio("Start with", "Ask each time")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(radio("Start with", "Claude Code"));
    expect(getThreadDefaults().harness).toBe(H);
    fireEvent.click(radio("Start with", "Ask each time"));
    expect(getThreadDefaults().harness).toBeNull();
  });

  it("sets a harness's default model, effort and permission mode from the launch table", () => {
    render(<NewThreadSettings />);
    fireEvent.click(radio("Defaults for", "Claude Code"));
    fireEvent.click(radio("Default model", models[1]!.label));
    fireEvent.click(radio("Default effort", pickersFor(H).efforts![0]!));
    fireEvent.click(radio("Default permission mode", "Plan"));
    expect(getThreadDefaults().perHarness[H]).toEqual({ model: models[1]!.id, effort: pickersFor(H).efforts![0], permissionMode: "plan" });
    expect(radio("Default model", models[1]!.label)).toHaveAttribute("aria-checked", "true");
    fireEvent.click(radio("Default model", "Default"));
    expect(getThreadDefaults().perHarness[H]?.model ?? "").toBe("");
  });

  it("offers no bypass mode as a default, and says why", () => {
    render(<NewThreadSettings />);
    fireEvent.click(radio("Defaults for", "Claude Code"));
    expect(within(screen.getByRole("radiogroup", { name: "Default permission mode" })).queryByRole("radio", { name: bypassLabel })).toBeNull();
    expect(screen.getByText(/never a default/)).toBeInTheDocument();
  });

  it("says which choices can change after the start", () => {
    render(<NewThreadSettings />);
    fireEvent.click(radio("Defaults for", "Claude Code"));
    expect(screen.getAllByText(/Can change after start|Fixed at start/).length).toBeGreaterThanOrEqual(2);
  });

  it("adds, stars, hides and removes models; the spawn picker follows", () => {
    render(
      <>
        <NewThreadSettings />
        <ProviderModelPicker />
      </>,
    );
    setDraftHarnessAct(H);
    const list = screen.getByRole("list", { name: "Models" });
    // add
    fireEvent.change(screen.getByRole("textbox", { name: "Add a model id" }), { target: { value: "claude-opus-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(within(list).getByText("claude-opus-9")).toBeInTheDocument();
    expect(radio("Model", "claude-opus-9")).toBeInTheDocument();
    // star: it moves first
    fireEvent.click(within(list).getByRole("button", { name: "Star claude-opus-9" }));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("claude-opus-9");
    // hide a suggestion
    fireEvent.click(within(list).getByRole("button", { name: `Hide ${models[0]!.label}` }));
    expect(within(screen.getByRole("radiogroup", { name: "Model" })).queryByRole("radio", { name: models[0]!.label })).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: `Show ${models[0]!.label}` }));
    expect(radio("Model", models[0]!.label)).toBeInTheDocument();
    // remove
    fireEvent.click(within(list).getByRole("button", { name: "Remove claude-opus-9" }));
    expect(within(list).queryByText("claude-opus-9")).toBeNull();
  });

  it("refuses a bad id with the reason, and keeps the text", () => {
    render(<NewThreadSettings />);
    const input = screen.getByRole("textbox", { name: "Add a model id" });
    fireEvent.change(input, { target: { value: "two words" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText(/Letters, digits/)).toBeInTheDocument();
    expect(input).toHaveValue("two words");
    expect(getThreadDefaults().models).toEqual({});
  });
});

describe("the spawn picker's Other model", () => {
  it("a typed id can be saved to the list, so it is never typed twice", () => {
    render(<ProviderModelPicker />);
    setDraftHarnessAct(H);
    expect(screen.queryByRole("textbox", { name: "Other model id" })).toBeNull();
    fireEvent.click(radio("Model", "Other…"));
    fireEvent.change(screen.getByRole("textbox", { name: "Other model id" }), { target: { value: "claude-opus-9" } });
    expect(useDraftThread.getState().draft.model).toBe("claude-opus-9");
    fireEvent.click(screen.getByRole("button", { name: "Save to my models" }));
    expect(getThreadDefaults().models[H]!.custom).toEqual(["claude-opus-9"]);
    expect(radio("Model", "claude-opus-9")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Save to my models" })).toBeNull();
  });

  it("a starred model shows first in the picker", () => {
    render(
      <>
        <NewThreadSettings />
        <ProviderModelPicker />
      </>,
    );
    setDraftHarnessAct(H);
    fireEvent.click(within(screen.getByRole("list", { name: "Models" })).getByRole("button", { name: `Star ${models[2]!.label}` }));
    const chips = within(screen.getByRole("radiogroup", { name: "Model" })).getAllByRole("radio");
    expect(chips[1]).toHaveAccessibleName(models[2]!.label);
  });
});

function setDraftHarnessAct(id: string) {
  act(() => setDraftHarness(id));
}
