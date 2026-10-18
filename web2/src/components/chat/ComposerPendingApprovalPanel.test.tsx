import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeRequest } from "@shared/v2/contracts";
import { summarize } from "@/stream/apply";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

function permission(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    id: "r1",
    threadId: "t1",
    kind: "permission",
    prompt: "Do you want to proceed?",
    options: [
      { label: "Yes", keys: ["1"] },
      { label: "Yes, and don't ask again for: git status", keys: ["2"] },
      { label: "No", keys: ["3"] },
    ],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const panel = (request: RuntimeRequest, onRespond = vi.fn()) =>
  render(
    <ComposerPendingApprovalPanel request={request} pendingCount={1} respondingIndex={null} verdict={null} onRespond={onRespond} />,
  );

describe("ComposerPendingApprovalPanel — what is being approved", () => {
  it("names the tool and shows the command in a capped, scrollable monospace box", () => {
    panel(
      permission({
        subject: { title: "Run command", target: "git status --short && echo done", detail: "Show the working tree" },
      }),
    );
    expect(screen.getByRole("heading", { name: "Run command" })).toBeTruthy();
    const box = screen.getByLabelText("Command");
    expect(box.tagName).toBe("PRE");
    expect(box.textContent).toBe("git status --short && echo done");
    expect(box.className).toMatch(/max-h-32/);
    expect(box.className).toMatch(/overflow-auto/);
    expect(box.className).toMatch(/whitespace-pre-wrap/);
    expect(screen.getByText("Show the working tree")).toBeTruthy();
    expect(screen.getByLabelText("Prompt").textContent).toBe("Do you want to proceed?");
  });

  it("a file target is labelled Target; every option is a 44 px button", () => {
    const onRespond = vi.fn();
    panel(permission({ subject: { title: "Read file", target: "C:\\notes\\notes.md" } }), onRespond);
    expect(screen.getByRole("heading", { name: "Read file" })).toBeTruthy();
    expect(screen.getByLabelText("Target").textContent).toBe("C:\\notes\\notes.md");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Yes", "Yes, and don't ask again for: git status", "No"]);
    for (const b of buttons) expect(b.className).toMatch(/min-h-11/);
    fireEvent.click(buttons[0]!);
    expect(onRespond).toHaveBeenCalledWith(0);
  });

  it("without a subject the card keeps its generic heading", () => {
    panel(permission());
    expect(screen.getByRole("heading", { name: "Permission" })).toBeTruthy();
    expect(screen.queryByLabelText("Command")).toBeNull();
  });

  it("the shell summary never carries the subject", () => {
    const summary = summarize(permission({ subject: { title: "Run command", target: "export TOKEN=abc" } }));
    expect(JSON.stringify(summary)).not.toContain("TOKEN");
  });
});
