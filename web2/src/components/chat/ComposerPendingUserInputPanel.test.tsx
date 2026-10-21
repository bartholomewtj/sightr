import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type RuntimeRequest } from "@shared/v2/contracts";
import { __setComposerDeps } from "@/state/composer";
import { threadFromSnapshot } from "@/stream/apply";
import { useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatComposer } from "./ChatComposer";

// T17: the question panel for wizard steps, checkbox (multi-select) steps and preview selects, with
// T3's ComposerPendingUserInputPanel behaviour. Rendered through ChatComposer, which swaps it in.

let posts: Record<string, unknown>[] = [];
let seq = 100;

beforeEach(() => {
  posts = [];
  seq = 100;
  setViewportWidth(800);
  let n = 0;
  __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true, sequence: ++seq });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

function setRequests(requests: RuntimeRequest[]): void {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: { ...NO_CAPABILITIES, hasJournal: true }, status: "input" }),
        runs: [],
        items: [],
        requests,
        queue: [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
}

function show(...requests: RuntimeRequest[]) {
  setRequests(requests);
  return render(<ChatComposer threadId="t1" />);
}

const responds = () => posts.filter((p) => p.type === "runtime-request.respond");
const panel = () => screen.getByRole("region", { name: "The agent is asking" });

function question(over: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    id: "r1",
    threadId: "t1",
    kind: "question",
    prompt: "Which toppings?",
    options: [
      { label: "Pepperoni", keys: ["1"], description: "Cured slices." },
      { label: "Mushrooms", keys: ["2"] },
      { label: "Peppers", keys: ["3"] },
      { label: "Olives", keys: ["4"] },
      { label: "Chat about this", keys: ["6"], destructive: true },
    ],
    status: "pending",
    bindingHash: "h",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const checkbox = (over: Partial<RuntimeRequest> = {}) =>
  question({
    multiSelect: { checked: [false, true, false, false], advanceLabel: "Next" },
    steps: [
      { label: "Toppings", answered: true, current: true },
      { label: "Crust", answered: false, current: false },
    ],
    ...over,
  });

describe("ComposerPendingUserInputPanel — checkbox steps", () => {
  it("seeds the boxes from the terminal, toggles locally, and the advance button posts the wanted set", async () => {
    show(checkbox());
    const boxes = within(panel()).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true", "false", "false"]);
    expect(within(panel()).getByText("Select one or more options.")).toBeInTheDocument();

    fireEvent.click(boxes[2]!);
    fireEvent.click(boxes[1]!);
    fireEvent.click(boxes[0]!);
    expect(within(panel()).getAllByRole("checkbox").map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "true", "false"]);
    expect(posts).toEqual([]);

    const next = within(panel()).getByRole("button", { name: "Next" });
    fireEvent.click(next);
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ requestId: "r1", optionIndices: [0, 2] })]));
    expect(responds()[0]).not.toHaveProperty("optionIndex");
    expect(within(panel()).getByRole("button", { name: /Next/ })).toHaveAttribute("aria-busy", "true");
  });

  it("digits toggle boxes; the advance needs at least one box", () => {
    show(checkbox({ multiSelect: { checked: [false, false, false, false], advanceLabel: "Submit" } }));
    const submit = within(panel()).getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "4" });
    expect(within(panel()).getAllByRole("checkbox")[3]).toHaveAttribute("aria-checked", "true");
    expect(submit).toBeEnabled();
    expect(posts).toEqual([]);
  });

  it("Chat about this sits last, is not a box, and needs a second tap", async () => {
    show(checkbox());
    const chat = within(panel()).getByRole("button", { name: /Chat about this/ });
    expect(chat).not.toHaveAttribute("role", "checkbox");
    fireEvent.click(chat);
    expect(chat).toHaveTextContent("Tap again to confirm");
    expect(posts).toEqual([]);
    fireEvent.click(chat);
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ optionIndex: 4 })]));
  });

  it("a new request (the screen changed) starts over from its own boxes", () => {
    show(checkbox());
    fireEvent.click(within(panel()).getAllByRole("checkbox")[0]!);
    act(() => setRequests([checkbox({ id: "r2", multiSelect: { checked: [false, false, false, true], advanceLabel: "Next" } })]));
    expect(within(panel()).getAllByRole("checkbox").map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"]);
  });
});

describe("ComposerPendingUserInputPanel — wizard steps", () => {
  it("shows the stepper with the current step and answers a step with one tap", async () => {
    show(
      question({
        prompt: "Which crust?",
        options: [
          { label: "Thin", keys: ["1"] },
          { label: "Deep", keys: ["2"] },
        ],
        steps: [
          { label: "Toppings", answered: true, current: false },
          { label: "Crust", answered: false, current: true },
        ],
      }),
    );
    const steps = within(panel()).getByRole("list", { name: "Questions" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Toppings", "Crust", "Submit"]);
    expect(within(steps).getByText("Crust").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(steps).getByLabelText("Answered")).toBeInTheDocument();
    expect(within(panel()).getByRole("status")).toHaveTextContent("Step 2 of 3, Crust");

    const deep = within(panel()).getByRole("button", { name: "Deep" });
    fireEvent.click(deep);
    // T3: the check shows at once, the answer follows a beat later.
    expect(deep).toHaveAttribute("data-selected", "true");
    expect(posts).toEqual([]);
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ requestId: "r1", optionIndex: 1 })]));
  });

  const nav = () => posts.filter((p) => p.type === "runtime-request.navigate");
  const walkable = (over: Partial<RuntimeRequest> = {}) =>
    question({
      prompt: "Which crust?",
      options: [
        { label: "Thin", keys: ["Enter"] },
        { label: "Deep", keys: ["Down", "Enter"], chosen: true },
      ],
      navigable: true,
      steps: [
        { label: "Toppings", answered: true, current: false },
        { label: "Crust", answered: false, current: true },
      ],
      ...over,
    });

  it("shows which option the terminal has picked", () => {
    show(walkable());
    expect(within(panel()).getByRole("button", { name: /Deep/ })).toHaveAttribute("data-selected", "true");
    expect(within(panel()).getByRole("button", { name: /Thin/ })).not.toHaveAttribute("data-selected");
    expect(within(panel()).getByLabelText("Selected")).toBeInTheDocument();
  });

  it("Back and Next chevrons walk the steps without answering", async () => {
    show(walkable());
    fireEvent.click(within(panel()).getByRole("button", { name: "Next question" }));
    await waitFor(() => expect(nav()).toEqual([expect.objectContaining({ requestId: "r1", direction: "next" })]));
    expect(responds()).toEqual([]);
  });

  it("Back goes to the previous question; the arrow keys do the same", async () => {
    show(walkable());
    fireEvent.click(within(panel()).getByRole("button", { name: "Previous question" }));
    await waitFor(() => expect(nav()).toEqual([expect.objectContaining({ direction: "back" })]));
  });

  it("ArrowRight walks on, but never while typing in a field", async () => {
    show(walkable({ freeText: true }));
    fireEvent.keyDown(within(panel()).getByPlaceholderText("Your answer"), { key: "ArrowRight" });
    expect(nav()).toEqual([]);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(nav()).toEqual([expect.objectContaining({ direction: "next" })]));
  });

  it("the first question has no Back, the Submit step has no Next", () => {
    const first = show(
      walkable({
        steps: [
          { label: "Toppings", answered: false, current: true },
          { label: "Crust", answered: false, current: false },
        ],
      }),
    );
    expect(within(panel()).getByRole("button", { name: "Previous question" })).toBeDisabled();
    expect(within(panel()).getByRole("button", { name: "Next question" })).toBeEnabled();
    first.unmount();
    show(
      walkable({
        prompt: "Review your answers",
        options: [{ label: "Submit", keys: ["Enter"] }],
        answers: [{ question: "Toppings", answer: "Ham" }],
        steps: [
          { label: "Toppings", answered: true, current: false },
          { label: "Crust", answered: true, current: false },
        ],
      }),
    );
    expect(within(panel()).getByRole("button", { name: "Previous question" })).toBeEnabled();
    expect(within(panel()).getByRole("button", { name: /Next/ })).toBeDisabled();
  });

  it("a card that is not navigable draws no chevrons", () => {
    show(walkable({ navigable: undefined }));
    expect(within(panel()).queryByRole("button", { name: "Next question" })).toBeNull();
  });

  it("the review lists the answers, Submit answers, Cancel needs two taps", async () => {
    show(
      question({
        prompt: "Review your answers",
        options: [
          { label: "Submit", keys: ["1"] },
          { label: "Cancel", keys: ["2"], destructive: true },
        ],
        answers: [
          { question: "Which toppings?", answer: "Pepperoni, Peppers" },
          { question: "Which crust?", answer: "Deep" },
        ],
        steps: [
          { label: "Toppings", answered: true, current: false },
          { label: "Crust", answered: true, current: false },
        ],
      }),
    );
    const answers = within(panel()).getByLabelText("Your answers");
    expect(within(answers).getByText("Pepperoni, Peppers")).toBeInTheDocument();
    expect(within(answers).getByText("Which crust?")).toBeInTheDocument();
    expect(within(panel()).getByText("Submit", { selector: "li span" }).closest("li")).toHaveAttribute("aria-current", "step");

    const cancel = within(panel()).getByRole("button", { name: /Cancel/ });
    fireEvent.click(cancel);
    expect(cancel).toHaveTextContent("Tap again to confirm");
    fireEvent.click(within(panel()).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ optionIndex: 0 })]));
  });
});

describe("ComposerPendingUserInputPanel — preview selects", () => {
  it("draws the preview pane under the pointed option only", () => {
    show(
      question({
        prompt: "Which layout?",
        options: [
          { label: "Grid", keys: ["1"] },
          { label: "List", keys: ["2"] },
        ],
        preview: { optionIndex: 1, lines: ["┌────┐", "│ ≡≡ │", "└────┘"] },
      }),
    );
    const pre = within(panel()).getByLabelText("Preview of List");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveTextContent("│ ≡≡ │");
    expect(within(panel()).queryByLabelText("Preview of Grid")).toBeNull();
    // It sits right under the List button.
    const list = within(panel()).getByRole("button", { name: "List" });
    expect(list.nextElementSibling).toBe(pre);
  });
});

describe("ComposerPendingUserInputPanel — Type your own answer (freeText)", () => {
  const single = (over: Partial<RuntimeRequest> = {}) =>
    question({
      prompt: "Which option do you choose?",
      options: [
        { label: "A", keys: ["1", "Enter"] },
        { label: "B", keys: ["2", "Enter"] },
      ],
      freeText: true,
      ...over,
    });

  it("shows a 16px, 44px answer field and posts the typed text as `text`", async () => {
    show(single());
    const box = within(panel()).getByLabelText("Type your own answer");
    expect(box.className).toMatch(/\btext-base\b/);
    expect(box.className).toMatch(/\bmin-h-11\b/);
    const send = within(panel()).getByRole("button", { name: /Send/ });
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: "  my own answer " } });
    fireEvent.click(send);
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ requestId: "r1", text: "my own answer" })]));
    expect(responds()[0]).not.toHaveProperty("optionIndex");
    // Typing digits in the field never picks an option.
    expect(responds()).toHaveLength(1);
  });

  it("digits typed in the field are text, not option picks", () => {
    show(single());
    const box = within(panel()).getByLabelText("Type your own answer");
    box.focus();
    fireEvent.keyDown(box, { key: "1" });
    expect(posts).toEqual([]);
  });

  it("Enter sends on a desktop; on a touch screen it does not (dictation, the soft return)", async () => {
    show(single());
    const box = within(panel()).getByLabelText("Type your own answer");
    const original = window.matchMedia;
    try {
      window.matchMedia = ((media: string) => ({ ...original(media), matches: /pointer:\s*coarse/.test(media) })) as typeof window.matchMedia;
      fireEvent.change(box, { target: { value: "on the phone" } });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(responds()).toEqual([]);
    } finally {
      window.matchMedia = original;
    }
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(responds()).toEqual([expect.objectContaining({ text: "on the phone" })]));
  });

  it("a focused row (no options) shows only the field, not Open terminal", () => {
    show(single({ options: [] }));
    expect(within(panel()).getByLabelText("Type your own answer")).toBeInTheDocument();
    expect(within(panel()).queryByText("Answer in the Terminal tab.")).toBeNull();
  });

  it("no freeText: no field; a review step never shows one", () => {
    show(question());
    expect(within(panel()).queryByLabelText("Type your own answer")).toBeNull();
  });

  it("a refusal keeps the draft and shows why", async () => {
    server.use(
      http.post("/api/v2/command", () => HttpResponse.json({ ok: false, code: "invalid", error: "no-free-text" }, { status: 400 })),
    );
    show(single());
    const box = within(panel()).getByLabelText("Type your own answer");
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.click(within(panel()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(within(panel()).getByText("This question has no empty answer box on screen now.")).toBeInTheDocument());
    expect(within(panel()).getByLabelText("Type your own answer")).toHaveValue("keep me");
  });
});
