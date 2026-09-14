import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./agent-chat";
import { fixtureAgents } from "@/test/handlers";
import { setDesktop, __resetDesktop } from "@/lib/desktop";

vi.mock("@/lib/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/actions")>()),
  submitPromptOption: vi.fn().mockResolvedValue({ status: "sent" }),
  submitPromptFeedback: vi.fn(),
  submitWizardKeys: vi.fn(),
}));
vi.mock("@/lib/dialog-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dialog-guard")>()),
  awaitDialogSettled: vi.fn().mockResolvedValue({ status: "timeout" }),
}));
import { submitPromptOption } from "@/lib/actions";
import { submitWizardKeys } from "@/lib/actions";

// The action mock above is intentionally partial; all other action exports remain real.

const wizard = [
  "←  ☐ Focus area  ☐ Scope  ✔ Submit  →",
  "",
  "Which focus area should we work on?",
  "",
  "❯ 1. Parser",
  "  2. UI",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

const menu = [
  "Do you want to create hello.txt?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

beforeEach(() => {
  localStorage.clear();
  __resetDesktop();
  vi.mocked(submitPromptOption).mockClear();
  Element.prototype.scrollTo = () => {};
});
afterEach(() => { cleanup(); __resetDesktop(); });

describe("AgentChat desktop prompt picking", () => {
  it("passes option 2 with its label and detected revision to the existing prompt action", async () => {
    setDesktop(true);
    localStorage.setItem("sightr:display-prefs:v6", JSON.stringify({ fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true }));
    const agent = fixtureAgents[0]!;
    const router = createMemoryRouter([{ path: "/", element: <AgentChat
      paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]}
      text={menu} onBack={() => {}} onSelect={() => {}}
    /> }]);
    render(<RouterProvider router={router} />);
    const box = await screen.findByPlaceholderText(/type a reply/i);
    fireEvent.keyDown(box, { key: "2" });
    await waitFor(() => expect(submitPromptOption).toHaveBeenCalledWith(expect.objectContaining({
      detectedRevision: 0,
      option: expect.objectContaining({ label: "No", keys: ["2"] }),
    })));
  });

  it("reports an unmatched digit", async () => {
    setDesktop(true);
    localStorage.setItem("sightr:display-prefs:v6", JSON.stringify({ fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true }));
    const agent = fixtureAgents[0]!;
    const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} text={menu} onBack={() => {}} onSelect={() => {}} /> }]);
    render(<RouterProvider router={router} />);
    fireEvent.keyDown(await screen.findByPlaceholderText(/type a reply/i), { key: "7" });
    expect(await screen.findByText("No option 7")).toBeInTheDocument();
    expect(submitPromptOption).not.toHaveBeenCalled();
  });

  it("keeps wizard digits for the dialog", async () => {
    setDesktop(true);
    localStorage.setItem("sightr:display-prefs:v6", JSON.stringify({ fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true }));
    const agent = fixtureAgents[0]!;
    const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} text={wizard} onBack={() => {}} onSelect={() => {}} /> }]);
    render(<RouterProvider router={router} />);
    fireEvent.keyDown(await screen.findByPlaceholderText(/type a reply/i), { key: "1" });
    expect(await screen.findByText("Use the buttons for this dialog")).toBeInTheDocument();
    expect(submitPromptOption).not.toHaveBeenCalled();
    expect(submitWizardKeys).not.toHaveBeenCalled();
  });
});
