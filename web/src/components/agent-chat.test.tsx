import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetDesktop, setDesktop, setTyping } from "@/lib/desktop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, act, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import { submitMultiSelectIntent, submitPromptOption, submitWizardKeys } from "@/lib/actions";
import { fixtureAgents } from "@/test/handlers";
import { AgentChat } from "./agent-chat";
import { resetDialogPresence, withDialogPresence } from "@/lib/dialog-presence";
import type { AgentView } from "@/lib/types";
import { openMore } from "@/test/composer-menu";
import { openPaneDetails, pickPaneDetails } from "@/test/pane-details";
import { requestArmToggle } from "@/lib/direct-arm";

const parseCounters = vi.hoisted(() => ({ parse: 0, blocks: 0 }));


// Mock the race guard at AgentChat's seam so the frozen-revision tests can observe exactly what
// `detectedRevision` the tap handler passes (the guard's own behaviour is covered in
// prompt-select-block.test.tsx). The other tests in this file never reach it.
vi.mock("@/lib/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/actions")>()),
  submitPromptOption: vi.fn(),
  submitWizardKeys: vi.fn(),
  submitMultiSelectIntent: vi.fn(),
}));
vi.mock("@/lib/ansi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ansi")>("@/lib/ansi");
  return {
    ...actual,
    parseAnsi: vi.fn((text: string) => {
      parseCounters.parse += 1;
      return actual.parseAnsi(text);
    }),
  };
});
vi.mock("@/lib/harness", async () => {
  const actual = await vi.importActual<typeof import("@/lib/harness")>("@/lib/harness");
  return {
    ...actual,
    buildBlocks: vi.fn((...args: Parameters<typeof actual.buildBlocks>) => {
      parseCounters.blocks += 1;
      return actual.buildBlocks(...args);
    }),
  };
});


// The detail view's core job: type a reply and submit it to the bridge. This drives the whole wired
// path (composer → api.sendReply → MSW → optimistic clear / error surfacing) end-to-end, which no
// other test covers. AgentChat uses useRevalidator, so it needs a data router (createMemoryRouter).

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  localStorage.clear();
  sessionStorage.clear();
  __resetDesktop();
});
afterEach(() => {
  __resetDesktop();
});

const DISPLAY_PREFS_KEY = "sightr:display-prefs:v6";

/** Persist display prefs. Raw terminal defaults on; tests can turn it off to assert chrome stripping. */
function writeDisplayPrefs(
  partial: Partial<{
    fontSize: number;
    rawTerminal: boolean;
    tapToFocus: boolean;
    showTerminal: boolean;
    showThinking: boolean;
  }> = {},
) {
  localStorage.setItem(
    DISPLAY_PREFS_KEY,
    JSON.stringify({ fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true, ...partial }),
  );
}

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

describe("AgentChat — reply flow", () => {
  it("sends a typed reply and clears the composer on success", async () => {
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    expect(box).toHaveValue("looks good");

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the draft and surfaces the error when the bridge rejects the send", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, error: "agent busy" }),
      ),
    );
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "retry this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("agent busy")).toBeInTheDocument();
    expect(box).toHaveValue("retry this"); // not cleared on failure
  });
});

describe("AgentChat — header title block", () => {
  it("is one line: the space leads, no directory subline, no repeated agent name", () => {
    renderChat(); // claude @ /home/you/webapp
    expect(screen.getByText("webapp")).toBeInTheDocument(); // space leads
    // The cwd left the header row; it lives in the details sheet as the full path.
    expect(screen.queryByText("~/webapp")).toBeNull();
    expect(screen.queryByText("/home/you/webapp")).toBeNull();
    // The agent is conveyed by its icon (aria-label only), so its name isn't repeated as text.
    expect(screen.queryByText(/claude/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Pane details" })).toBeInTheDocument();
    // No header button for Find any more, and no status pill text.
    expect(screen.queryByRole("button", { name: "Find in output" })).toBeNull();
    expect(screen.queryByText("needs you")).toBeNull();
  });

  it("shows the full working directory and the space overview row in the details sheet", () => {
    renderChat();
    const sheet = openPaneDetails();
    expect(within(sheet).getByText("/home/you/webapp")).toHaveClass("font-mono");
    expect(within(sheet).getByRole("button", { name: "Context" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Open space overview" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Find in output" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Switch pane…" })).toBeInTheDocument();
  });

  it("shows Grok's header 20K/500K on the Context row even with the terminal hidden", () => {
    writeDisplayPrefs({ showTerminal: false });
    const grok = fixtureAgents[1]!;
    const text = readFileSync(
      join(import.meta.dirname, "../fixtures/panes/grok--fresh-idle.txt"),
      "utf8",
    );
    renderChat({ agent: grok, paneId: grok.paneId, text });
    const sheet = openPaneDetails();
    expect(within(sheet).getByRole("button", { name: /Context/ })).toHaveTextContent("20K/500K");
  });

  it("shows Pi's footer 4.1%/200k on the Context row even with the terminal hidden", () => {
    writeDisplayPrefs({ showTerminal: false });
    const pi = { ...fixtureAgents[0]!, agent: "pi", paneId: "w1:p3" };
    renderChat({
      agent: pi,
      paneId: pi.paneId,
      text: "↑1.5k ↓3.4k 4.1%/200k (auto)  muse-spark-1.3 • medium",
    });
    const sheet = openPaneDetails();
    expect(within(sheet).getByRole("button", { name: /Context/ })).toHaveTextContent("4.1%/200k");
  });

  it("opens the space overview (navigates home with space expanded) from the details sheet", async () => {
    localStorage.clear();
    const agent = fixtureAgents[0]!; // workspaceId w1
    const router = createMemoryRouter(
      [
        { path: "/", element: <div data-testid="home">HOME</div> },
        {
          path: "/pane/:paneId",
          element: (
            <AgentChat
              paneId={agent.paneId}
              agent={agent}
              agents={fixtureAgents}
              shellPanes={[]}
              text="out"
              onBack={vi.fn()}
              onSelect={vi.fn()}
            />
          ),
        },
      ],
      { initialEntries: ["/pane/w1:p1"] },
    );
    render(<RouterProvider router={router} />);

    pickPaneDetails("Open space overview");
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    const saved = JSON.parse(localStorage.getItem("sightr:dash-prefs:v2") ?? "{}");
    expect(saved.spaceOpen?.w1).toBe(true);
  });
});

describe("AgentChat — read-only device", () => {
  it("disables the composer and shows the banner when the device isn't authorised", () => {
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });

    // The banner names the read-only state (and the device id), and the composer is locked.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/spare-phone/)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only — device not authorised/i);
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // The terminal mirror still renders — reading is always allowed.
    expect(screen.getByText("recent pane output")).toBeInTheDocument();
  });

  it("keeps the composer live for an authorised device", () => {
    renderChat({ device: { enforced: true, device: "my-phone", authorized: true } });
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a reply/i)).not.toBeDisabled();
  });
});

describe("AgentChat — raw-terminal mode", () => {
  it("shows the verbatim mirror and native buttons by default", async () => {
    renderChat({ text: MENU_TEXT });
    // Raw keeps the complete menu in the mirror while the detected dialog is also tappable below it.
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByText(/Do you want to create hello\.txt\?/)).toBeInTheDocument();
    expect(screen.getByText(/❯ 1\. Yes/)).toBeInTheDocument();
  });

  it("lifts a tail menu into buttons when raw terminal is off", async () => {
    writeDisplayPrefs({ rawTerminal: false });
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
    // The raw option row is consumed into the button, not shown as text.
    expect(screen.queryByText(/❯ 1\. Yes/)).not.toBeInTheDocument();
  });

  // "Tap to type" — on, the mirror is one big "start typing" target; off, it is a document. The
  // pref must gate ONLY the focus, never the mirror's own controls: someone who turned it off to
  // stop the keyboard appearing has not asked to lose the prompt buttons.
  it("focuses the composer on a mirror tap by default", async () => {
    renderChat({ text: "just some output\n" });
    const line = screen.getByText(/just some output/);
    fireEvent.click(line);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText(/Type a reply/i)));
  });

  it("leaves focus alone on a mirror tap when Tap to type is off", async () => {
    writeDisplayPrefs({ tapToFocus: false });
    renderChat({ text: "just some output\n" });
    const before = document.activeElement;
    fireEvent.click(screen.getByText(/just some output/));
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText(/Type a reply/i));
  });

  it("still lifts a menu into buttons with Tap to type off — it gates focus, not the grammars", async () => {
    writeDisplayPrefs({ rawTerminal: false, tapToFocus: false });
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  it("shows wizard buttons while keeping the verbatim dialog in the raw dump", async () => {
    renderChat({ text: WIZARD_TEXT });
    expect(await screen.findByRole("button", { name: /Parser/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeInTheDocument();
    expect(screen.getByText(/1\. Parser/)).toBeInTheDocument();
    expect(screen.getByText(/☐ Focus area/)).toBeInTheDocument();
  });

  it("keeps Claude chrome and statusline in the raw dump", () => {
    renderChat({ text: STATUS_TEXT });
    const terminal = screen.getByText(/❯/).closest("pre");
    expect(terminal).not.toBeNull();
    expect(screen.getByText(/\[Opus 4\.8\] ~\/webapp · main/).closest("pre")).toBe(terminal);
  });

  it("lifts a multi-question wizard into native controls when raw terminal is off", async () => {
    writeDisplayPrefs({ rawTerminal: false });
    renderChat({ text: WIZARD_TEXT });
    expect(await screen.findByRole("button", { name: /Parser/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeInTheDocument();
    // The stepper header row is consumed into the wizard block, not mirrored as text.
    expect(screen.queryByText(/☐ Focus area/)).not.toBeInTheDocument();
  });
});

describe("AgentChat — desktop number keys with raw terminal on", () => {
  beforeEach(() => {
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: "plain output without dialog",
          truncated: false,
          revision: 10,
        }),
      ),
    );
  });

  it("picks a prompt option with number 1", async () => {
    setDesktop(true);
    const mockSubmit = vi.mocked(submitPromptOption);
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
    renderChat({ text: MENU_TEXT });
    const box = await screen.findByPlaceholderText(/type a reply/i);

    fireEvent.keyDown(box, { key: "1" });
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({
      option: expect.objectContaining({ label: "Yes", keys: ["1"] }),
    })));
  });

});

// A minimal permission dialog at the buffer tail — enough for the REAL detector (not a mock) to
// lift it into prompt-select buttons inside AgentChat's mirror.
const MENU_TEXT = [
  "Do you want to create hello.txt?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

// A minimal Claude input-box buffer at the tail: top border, the "❯" prompt, bottom border, then the
// statusline + a hint. For a Claude pane, chrome-stripping peels the box off the mirror and the
// statusline is re-surfaced as the app strip; for a non-Claude pane none of that runs (raw mirror).
const RULE = "─".repeat(60);
const STATUS_TEXT = [
  "Welcome back!",
  "",
  RULE,
  "❯ ",
  RULE,
  "  [Opus 4.8] ~/webapp · main",
  "  ← for agents",
].join("\n");

// A minimal multi-question wizard tail (stepper header + current question) — enough for the REAL
// wizard detector to lift it into the native WizardBlock inside AgentChat's mirror.
const WIZARD_TEXT = [
  "←  ☐ Focus area  ☐ Scope  ✔ Submit  →",
  "",
  "Which focus area should we work on?",
  "",
  "❯ 1. Parser",
  "  2. UI",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

// Renders AgentChat inside a data router with EXTERNALLY-UPDATABLE pane props, standing in for the
// route loader delivering fresh polls. Returns a setter that advances {text, revision} in place.
function renderWithLivePane(initial: { text: string; revision: number }) {
  const agent = fixtureAgents[0]!; // a claude agent — the block grammars are gated on the agent
  let advance: (pane: { text: string; revision: number }) => void = () => {
    throw new Error("harness not mounted");
  };
  function Harness() {
    const [pane, setPane] = useState(initial);
    advance = setPane;
    return (
      <AgentChat
        paneId={agent.paneId}
        agent={agent}
        agents={fixtureAgents}
        shellPanes={[]}
        text={pane.text}
        revision={pane.revision}
        onBack={vi.fn()}
        onSelect={vi.fn()}
      />
    );
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  render(<RouterProvider router={router} />);
  return (pane: { text: string; revision: number }) => advance(pane);
}

describe("AgentChat — prompt-select race guard wiring (frozen {text, revision} pair)", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    writeDisplayPrefs({ rawTerminal: false });
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: "plain output without dialog",
          truncated: false,
          revision: 10,
        }),
      ),
    );
  });

  it("parses and builds blocks once for each display change", async () => {
    const advance = renderWithLivePane({ text: "initial output", revision: 1 });
    parseCounters.parse = 0;
    parseCounters.blocks = 0;

    act(() => advance({ text: "updated output", revision: 2 }));

    await waitFor(() => {
      expect(parseCounters.parse).toBe(1);
      expect(parseCounters.blocks).toBe(1);
    });
  });

  it("passes the FROZEN revision when the mirror is frozen and the pane advances underneath", async () => {
    // Regression (found in review): the handler used to pass the LIVE loader revision, which keeps
    // advancing via background polls even while the mirror is frozen — so the guard compared
    // live-vs-live and could never catch drift that happened before the freeze. The menu the user
    // taps is derived from the FROZEN text, so the guard must get the revision frozen WITH it.
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });

    // The real detector lifted the tail menu into buttons.
    await screen.findByRole("button", { name: "Yes" });

    // Freeze the mirror (opening find pins the tail — the same `following=false` state a scroll-up
    // freeze produces).
    pickPaneDetails("Find in output");

    // The pane advances while frozen: new output below the menu + a bumped revision.
    act(() => advance({ text: `${MENU_TEXT}\n● proceeding…\n`, revision: 2 }));

    // The frozen mirror still shows the old menu; the tap must hand the guard the FROZEN pair.
    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });

  it("passes the LIVE revision while following (the frozen pair is the live pair)", async () => {
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });
    await screen.findByRole("button", { name: "Yes" });

    // Not frozen: a revision-only poll (same text) is adopted into the shown pair.
    act(() => advance({ text: MENU_TEXT, revision: 2 }));

    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 2 }));
  });

  // Same frozen-pair guarantee for the wizard path (the guard mirrors prompt-select's; this locks the
  // wiring so the live-vs-frozen-revision bug can't regress here either).
  it("wizard: passes the FROZEN revision when the mirror is frozen and the pane advances", async () => {
    const mockWizard = vi.mocked(submitWizardKeys);
    mockWizard.mockReset();
    mockWizard.mockResolvedValue({ status: "sent" });

    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: WIZARD_TEXT, revision: 1 });

    // The real detector lifted the multi-question tail into a wizard with option buttons.
    await screen.findByRole("button", { name: /Parser/ });

    pickPaneDetails("Find in output"); // freeze the tail
    act(() => advance({ text: `${WIZARD_TEXT}\n● advancing…\n`, revision: 2 }));

    await user.click(screen.getByRole("button", { name: /Parser/ }));

    await waitFor(() => expect(mockWizard).toHaveBeenCalledTimes(1));
    expect(mockWizard).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });
});

describe("AgentChat — dialog tap unlocks on a fresh snapshot (#368)", () => {
  const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
  const fixture = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
  const singleText = fixture("claude--select-multiselect-single.txt");
  const cheeseCheckedText = singleText.replace("1. \x1b[0m[ ]", "1. \x1b[0m[✔]");
  const reviewText = fixture("claude--select-multiselect-review.txt");

  const mockSubmitMulti = vi.mocked(submitMultiSelectIntent);
  const mockSubmitPrompt = vi.mocked(submitPromptOption);
  const mockSubmitWizard = vi.mocked(submitWizardKeys);

  beforeEach(() => {
    writeDisplayPrefs({ rawTerminal: false });
    mockSubmitMulti.mockReset();
    mockSubmitPrompt.mockReset();
    mockSubmitWizard.mockReset();
  });

  it("checkbox without remount: tap Cheese -> Cheese is aria-checked=true without leaving pane", async () => {
    const user = userEvent.setup();
    mockSubmitMulti.mockResolvedValue({ status: "sent" });
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: cheeseCheckedText,
          truncated: false,
          revision: 2,
        }),
      ),
    );

    renderWithLivePane({ text: singleText, revision: 1 });

    const cheeseBox = await screen.findByRole("checkbox", { name: /Cheese/ });
    expect(cheeseBox).toHaveAttribute("aria-checked", "false");

    await user.click(cheeseBox);

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /Cheese/ })).toHaveAttribute("aria-checked", "true");
    });
    expect(mockSubmitMulti).toHaveBeenCalledTimes(1);
    expect(mockSubmitMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: { kind: "toggle", n: 1 },
      }),
    );
  });

  it("locked while settling: controls are disabled and ignore clicks until settled", async () => {
    const user = userEvent.setup();
    mockSubmitMulti.mockResolvedValue({ status: "sent" });

    let resolvePane!: () => void;
    const paneGate = new Promise<void>((resolve) => {
      resolvePane = resolve;
    });

    server.use(
      http.get("/api/pane/:paneId", async () => {
        await paneGate;
        return HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: cheeseCheckedText,
          truncated: false,
          revision: 2,
        });
      }),
    );

    renderWithLivePane({ text: singleText, revision: 1 });

    const cheeseBox = await screen.findByRole("checkbox", { name: /Cheese/ });
    const mushroomsBox = screen.getByRole("checkbox", { name: /Mushrooms/ });

    // Click Cheese to begin toggle & settling
    await user.click(cheeseBox);

    // Right after click, every checkbox is disabled
    expect(cheeseBox).toBeDisabled();
    expect(mushroomsBox).toBeDisabled();

    // A second click on another box does nothing
    await user.click(mushroomsBox);
    expect(mockSubmitMulti).toHaveBeenCalledTimes(1);

    // Release the settle response
    resolvePane();

    // After settle, controls are enabled again
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /Cheese/ })).not.toBeDisabled();
    });
    expect(screen.getByRole("checkbox", { name: /Mushrooms/ })).not.toBeDisabled();
    expect(mockSubmitMulti).toHaveBeenCalledTimes(1);
  });

  it("review Submit removes the card once the TUI leaves the dialog without reload", async () => {
    const user = userEvent.setup();
    mockSubmitMulti.mockResolvedValue({ status: "sent" });
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: "plain terminal output without any dialog",
          truncated: false,
          revision: 2,
        }),
      ),
    );

    renderWithLivePane({ text: reviewText, revision: 1 });

    const submitBtn = await screen.findByRole("button", { name: /Submit answers/ });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Submit answers/ })).toBeNull();
    });
    expect(mockSubmitMulti).toHaveBeenCalledTimes(1);
  });

  it("failed guard unlocks immediately without polling for settle", async () => {
    const user = userEvent.setup();
    mockSubmitMulti.mockResolvedValue({ status: "changed" });

    let paneCalls = 0;
    server.use(
      http.get("/api/pane/:paneId", () => {
        paneCalls++;
        return HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: singleText,
          truncated: false,
          revision: 1,
        });
      }),
    );

    renderWithLivePane({ text: singleText, revision: 1 });

    const cheeseBox = await screen.findByRole("checkbox", { name: /Cheese/ });
    await user.click(cheeseBox);

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: /Cheese/ })).not.toBeDisabled();
    });
    expect(paneCalls).toBe(0);
    expect(mockSubmitMulti).toHaveBeenCalledTimes(1);
  });

  it("radio/wizard still submits once and reflects fresh snapshot", async () => {
    const user = userEvent.setup();
    mockSubmitWizard.mockResolvedValue({ status: "sent" });
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: "plain output — wizard closed",
          truncated: false,
          revision: 2,
        }),
      ),
    );

    renderWithLivePane({ text: WIZARD_TEXT, revision: 1 });

    const parserBtn = await screen.findByRole("button", { name: /Parser/ });
    await user.click(parserBtn);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Parser/ })).toBeNull();
    });
    expect(mockSubmitWizard).toHaveBeenCalledTimes(1);
  });
});

// The block grammars are provably scoped to the pane's own adapter (spec T8): an agent with no
// adapter gets the plain raw mirror — no prompt-select buttons, no chrome stripping, no re-surfaced
// status strip — because running Claude-tuned matchers on an unverified TUI could mis-lift or
// mis-strip its output. codex is such an agent: it ships a slash catalog but no adapter.
describe("AgentChat — block-grammar scoping (an agent with no adapter)", () => {
  // A codex agent sharing the Claude fixture's ids, so only the agent kind differs from the default.
  const codexAgent = { ...fixtureAgents[0]!, agent: "codex" };

  it("does NOT lift a codex tail menu into buttons — it stays raw mirror text", () => {
    renderChat({ text: MENU_TEXT, agent: codexAgent });
    const mirror = screen.getByTestId("mirror-region");
    // No native prompt buttons: the Claude prompt-select grammar never runs for codex…
    expect(within(mirror).queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    // …and the menu row shows verbatim in the raw mirror instead (drivable by the keys pad).
    expect(within(mirror).getByText(/1\. Yes/)).toBeInTheDocument();
  });

  it("keeps the blocked codex Yes / No strip outside the raw mirror", () => {
    renderChat({ text: MENU_TEXT, agent: codexAgent });
    const mirror = screen.getByTestId("mirror-region");
    const strip = document.querySelector<HTMLElement>("[data-yes-no]");
    expect(strip).not.toBeNull();
    expect(mirror).not.toContainElement(strip);
  });

  it("re-surfaces EVERY row of the Claude input-box statusline in the pane details sheet", () => {
    writeDisplayPrefs({ rawTerminal: false });
    renderChat({ text: STATUS_TEXT }); // default claude agent
    // Not on the pane screen itself any more — the strip moved behind the title.
    expect(screen.queryByText("[Opus 4.8] ~/webapp · main")).toBeNull();
    const sheet = openPaneDetails();
    const strip = within(sheet).getByText("[Opus 4.8] ~/webapp · main");
    expect(strip.closest("pre")).toBeNull(); // the strip is app chrome, not <pre> mirror text
    // Row 2 of the run: it used to be stripped off the mirror and rendered nowhere at all.
    const second = screen.getByText("← for agents");
    expect(second.closest("pre")).toBeNull();
    // Stacked in the one strip. Compared at the ROW level: each row renders one <span> per ANSI
    // segment (colour is carried through now), so the text node's own parent is a span, not the row.
    const row = (el: HTMLElement) => el.closest("div.truncate");
    expect(row(second)).not.toBe(row(strip));
    expect(row(second)?.parentElement).toBe(row(strip)?.parentElement);
    expect(screen.queryByText(/❯/)).toBeNull(); // the input box was stripped off the mirror
  });

  it("leaves a codex input-box buffer fully raw — no status strip, box kept in the mirror", () => {
    renderChat({ text: STATUS_TEXT, agent: codexAgent });
    // The statusline is NOT hoisted into an app strip — it stays inside the raw <pre> mirror…
    const status = screen.getByText(/\[Opus 4\.8\] ~\/webapp · main/);
    expect(status.closest("pre")).not.toBeNull();
    // …and the input box itself is preserved verbatim (no chrome stripping for a non-Claude agent).
    expect(screen.getByText(/❯/)).toBeInTheDocument();
  });
});

// Regression (user-reported on mobile): tapping a native prompt/wizard/preview option button popped
// the phone keyboard. Those buttons live INSIDE the terminal-mirror div, whose onClick focuses the
// composer (the "tap the mirror to start typing" affordance) — so an option tap bubbled up and
// focused the input, opening the soft keyboard over the output. focusFromMirror must ignore taps
// that land on an interactive control, while still focusing on a tap of the raw terminal text.
describe("AgentChat — mirror tap must not pop the keyboard on option taps", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
    server.use(
      http.get("/api/pane/:paneId", () =>
        HttpResponse.json({
          paneId: fixtureAgents[0]!.paneId,
          text: "plain output without dialog",
          truncated: false,
          revision: 10,
        }),
      ),
    );
  });

  it("does NOT focus the composer when a native prompt option is tapped", async () => {
    writeDisplayPrefs({ rawTerminal: false });
    const user = userEvent.setup();
    renderChat({ text: MENU_TEXT });
    const box = screen.getByPlaceholderText(/type a reply/i);
    const yes = await screen.findByRole("button", { name: "Yes" });

    await user.click(yes);
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(box).not.toHaveFocus();
  });

  it("DOES still focus the composer when the raw mirror text is tapped", async () => {
    const user = userEvent.setup();
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.click(screen.getByText("recent pane output"));
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("focuses during the tap event so mobile browsers can open the software keyboard", () => {
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    fireEvent.click(screen.getByText("recent pane output"));

    expect(box).toHaveFocus();
  });
});

// Connection copy now lives in the single top ConnectionBanner (mounted in RootLayout), not in the
// header — so the pane header has no pill. What it still owns: the agent status dot, which shows the
// LAST snapshot's status and must stop reading as current during an outage (it dims on any not-live).
describe("AgentChat — shared header: stale-status dimming", () => {
  beforeEach(() => __resetConnectionHealth());

  it("dims the agent status dot while the connection is not live and restores it on recovery", () => {
    // fixtureAgents[0] is a blocked claude agent → the dot is labelled "needs you".
    let setError: (e: boolean) => void = () => {};
    function Harness() {
      const [error, setErr] = useState(true);
      setError = setErr;
      const agent = fixtureAgents[0]!;
      return (
        <AgentChat
          paneId={agent.paneId}
          agent={agent}
          agents={fixtureAgents}
          shellPanes={[]}
          text="out"
          error={error}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
    render(<RouterProvider router={router} />);

    const badge = screen.getByRole("img", { name: "needs you" });
    expect(badge).toHaveClass("opacity-40"); // not live → frozen status dimmed
    act(() => setError(false)); // snapshot recovers → live
    expect(badge).not.toHaveClass("opacity-40"); // undimmed instantly
  });
});

describe("AgentChat — touch targets (#233)", () => {
  it("pans long mirror lines instead of wrapping them", () => {
    renderChat({ text: "a very long line" });
    const pre = screen.getByTestId("mirror-region").querySelector("pre");
    expect(pre).toHaveClass("whitespace-pre");
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
  });

  it("uses a 44px-tall title button and full-width rows for the pane actions", () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    renderChat({ agent, agents: [agent] });
    expect(screen.getByRole("button", { name: "Pane details" })).toHaveClass("min-h-11");
    const sheet = openPaneDetails();
    for (const name of ["Find in output", "Open space overview"]) {
      expect(within(sheet).getByRole("button", { name })).toHaveClass("w-full");
    }
  });
});

describe("AgentChat — Show terminal", () => {
  const idleWithJournal = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: true };
  const live = "live terminal output";

  it("hides the dump and Live seam when off, idle, and the journal is loaded", async () => {
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.queryByText(live)).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.queryByText("(no recent output)")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show live terminal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hide live terminal/i })).not.toBeInTheDocument();
  });

  it("hides the dump by default", async () => {
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.queryByText(live)).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("force-shows the dump for a blocked agent", async () => {
    const blocked = { ...fixtureAgents[0]!, hasSession: true };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: blocked, agents: [blocked], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.getByText(live)).toBeInTheDocument();
  });

  it("force-shows the dump when Find is open", async () => {
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    pickPaneDetails("Find in output");
    expect(screen.getByText(live)).toBeInTheDocument();
  });

  it("force-shows the dump when Type is armed", async () => {
    setDesktop(true);
    setTyping("direct");
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    act(() => requestArmToggle());
    expect(screen.getByText(live)).toBeInTheDocument();
  });

  it("keeps the dump for a pane without a journal", () => {
    const noJournal = { ...fixtureAgents[0]!, status: "idle" as const, hasSession: false };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: noJournal, agents: [noJournal], text: live });
    expect(screen.getByText(live)).toBeInTheDocument();
  });

  it("hides the dump while working too when the journal is available", async () => {
    const working = { ...idleWithJournal, status: "working" as const };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: working, agents: [working], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(live);
  });

  it("shows a thinking pulse instead of the dump while working", async () => {
    const working = { ...idleWithJournal, status: "working" as const };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: working, agents: [working], text: live });
    await waitFor(() => expect(screen.getByTestId("thinking-pulse")).toBeInTheDocument());
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(/Thinking 0:00/);
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(live);
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("hides the pulse snip when Show thinking is off, but keeps the timer", async () => {
    const working = { ...idleWithJournal, status: "working" as const };
    writeDisplayPrefs({ showTerminal: false, showThinking: false });
    renderChat({ agent: working, agents: [working], text: live });
    await waitFor(() => expect(screen.getByTestId("thinking-pulse")).toBeInTheDocument());
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent(/Thinking 0:00/);
    expect(screen.getByTestId("thinking-pulse")).not.toHaveTextContent(live);
  });

  it("still pulses when a tool is running — runningCommand is the previous journal tail", async () => {
    const working = { ...idleWithJournal, status: "working" as const, runningCommand: true };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: working, agents: [working], text: live });
    await waitFor(() => expect(screen.getByTestId("thinking-pulse")).toBeInTheDocument());
  });

  it("does not pulse when the dump is showing", async () => {
    writeDisplayPrefs({ showTerminal: true });
    const working = { ...idleWithJournal, status: "working" as const };
    renderChat({ agent: working, agents: [working], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.getByText(live)).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-pulse")).not.toBeInTheDocument();
  });

  it("lifts a Grok checkbox ask that Herdr does not mark blocked, even with the dump off", async () => {
    const grok = { ...fixtureAgents[1]!, status: "working" as const, hasSession: true };
    const text = readFileSync(join(import.meta.dirname, "../fixtures/panes/grok--ask-multi.txt"), "utf8");
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: grok, agents: [grok], paneId: grok.paneId, text });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Cheese/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("still hides ordinary Grok working output when the dump is off", async () => {
    const grok = { ...fixtureAgents[1]!, status: "working" as const, hasSession: true };
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: grok, agents: [grok], paneId: grok.paneId, text: "live terminal output" });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.getByTestId("thinking-pulse")).toHaveTextContent("live terminal output");
  });

  it("keeps lifted Grok ask buttons when the dump is hidden", async () => {
    const grok = { ...fixtureAgents[1]!, status: "idle" as const, hasSession: true };
    const text = readFileSync(join(import.meta.dirname, "../fixtures/panes/grok--ask-color.txt"), "utf8");
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: grok, agents: [grok], paneId: grok.paneId, text });
    await waitFor(() => expect(screen.getByRole("button", { name: /Red/ })).toBeInTheDocument());
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("pins the last send in the journal immediately while the dump is hidden", async () => {
    const user = userEvent.setup();
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(document.querySelector('[data-turn="pending-user"]')).toHaveTextContent("looks good"));
    expect(screen.getByTestId("thinking-pulse")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("does not invent a day divider under the pending send", async () => {
    const user = userEvent.setup();
    writeDisplayPrefs({ showTerminal: false });
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.type(box, "looks good");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(document.querySelector('[data-turn="pending-user"]')).toBeTruthy());
    const pending = document.querySelector('[data-turn="pending-user"]');
    expect(pending?.previousElementSibling?.textContent ?? "").not.toMatch(/Sept|Sep|2026/);
  });

  it("toggles the terminal dump with the composer toggle and persists the choice across a remount", async () => {
    const user = userEvent.setup();
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.queryByText(live)).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();

    openMore();
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Terminal" }));

    expect(screen.getByText(live)).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
    openMore();
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(window, { key: "Escape" });

    cleanup();
    renderChat({ agent: idleWithJournal, agents: [idleWithJournal], text: live });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.getByText(live)).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();

    openMore();
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Terminal" }));

    expect(screen.queryByText(live)).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    openMore();
    expect(screen.getByRole("menuitemcheckbox", { name: "Terminal" })).toHaveAttribute("aria-checked", "false");
  });
});

// Agent panes stack the journal above the live TUI so a swipe up reads the session. Shells still
// page Herdr scrollback with Load older when readableLines exceeds requestedLines. There is no
// Show live / Hide live control; Show terminal lives in Display.
describe("AgentChat — top-of-mirror history affordance", () => {
  beforeEach(() => {
    writeDisplayPrefs({ showTerminal: true });
  });
  const showHistory = () => screen.queryByRole("button", { name: /show entire history/i });
  const loadOlder = () => screen.queryByRole("button", { name: /load older/i });

  it("an agent pane inlines the transcript above the live tail and keeps the live TUI", async () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600, text: "live terminal output" });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(screen.getByText("live terminal output")).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
    expect(loadOlder()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show live terminal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /hide live terminal/i })).not.toBeInTheDocument();
  });

  it("a pane with real scrollback offers Load older", () => {
    // A shell on the primary screen: 6895 lines of ring + 51 viewport, and we've only asked for 600.
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("offers nothing when the pane has neither", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("hides Load older once the window already covers everything Herdr can return", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 700 };
    renderChat({ agent, agents: [agent], requestedLines: 1000 }); // at the cap, past the content
    expect(loadOlder()).not.toBeInTheDocument();
  });

  it("stays hidden when readableLines is unknown (older bridge) rather than offering a dud tap", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const }; // no readableLines
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("a transcript wins even when the pane also reports scrollback", async () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600, text: "live terminal output" });
    await waitFor(() => expect(screen.getByText("what changed today?")).toBeInTheDocument());
    expect(loadOlder()).not.toBeInTheDocument();
    expect(screen.getByText("live terminal output")).toBeInTheDocument();
  });

});

// Folded from agent-chat-scroll.test.tsx.
describe('desktop pane scroll containment', () => {
  beforeEach(() => { __resetDesktop(); Element.prototype.scrollTo = () => {}; });
  afterEach(() => __resetDesktop());
  function show() { const agent = fixtureAgents[0]!; const router = createMemoryRouter([{ path: "/", element: <AgentChat paneId={agent.paneId} agent={agent} agents={[agent]} shellPanes={[]} text={Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")} onBack={() => {}} onSelect={() => {}} /> }], { initialEntries: ["/"] }); return render(<RouterProvider router={router} />); }

  describe("desktop pane scroll containment", () => {
    it("keeps pane chrome outside the mirror scroller", () => { setDesktop(true); const view = show(); const scrollers = view.container.querySelectorAll(".overflow-y-auto"); expect(scrollers).toHaveLength(1); expect(scrollers[0]).not.toContainElement(view.container.querySelector("header")); expect(scrollers[0]).not.toContainElement(screen.getByPlaceholderText(/type a reply/i)); expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument(); expect(view.container.firstElementChild).toHaveClass("overflow-hidden"); expect(view.container.querySelector("div.relative.shrink-0")).toBeInTheDocument(); });
    it("preserves the phone class list", () => { const view = show(); expect(view.container.firstElementChild).toHaveClass("max-w-[100dvw]", "overflow-x-hidden"); expect(view.container.firstElementChild).not.toHaveClass("overflow-hidden"); expect(view.container.querySelector("div.relative.shrink-0")).toBeNull(); });
  });
});

describe("AgentChat — dialog presence glue (#372)", () => {
  beforeEach(() => {
    resetDialogPresence();
  });

  it("notes dialog presence for a working grok ask card and drops it when text changes to working output", () => {
    const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
    const askColorText = readFileSync(join(PANES_DIR, "grok--ask-color.txt"), "utf8");
    const workingText = readFileSync(join(PANES_DIR, "grok--working.txt"), "utf8");

    const grokAgent: AgentView = {
      paneId: "w2:p1",
      workspaceId: "w2",
      workspaceLabel: "sightr",
      workspaceNumber: 2,
      tabId: "w2:t1",
      agent: "grok",
      status: "working",
      cwd: "/home/you/sightr",
      focused: true,
      lastActiveAt: 10,
    };

    let setChatText!: (text: string) => void;
    function ChatWrapper() {
      const [text, setText] = useState(askColorText);
      setChatText = setText;
      return (
        <AgentChat
          paneId={grokAgent.paneId}
          agent={grokAgent}
          agents={[grokAgent]}
          shellPanes={[]}
          text={text}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }

    const router = createMemoryRouter([{ path: "/", element: <ChatWrapper /> }]);
    render(<RouterProvider router={router} />);

    expect(withDialogPresence([grokAgent])[0]!.dialogPresent).toBe(true);

    act(() => {
      setChatText(workingText);
    });

    expect(withDialogPresence([grokAgent])[0]!.dialogPresent).toBeUndefined();
  });
});
