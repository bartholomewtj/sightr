import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import type { ThreadSearchMatch } from "@shared/v2/contracts";
import { useCommandPaletteStore } from "@/commandPaletteBus";
import { clearItemJump, useItemJumpStore } from "@/state/itemJump";
import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";
import { server } from "@/test/setup";

import { MESSAGE_SEARCH_DEBOUNCE_MS } from "./CommandPaletteMessages";
import { normalizeRanges } from "./HighlightedSearchLine";

// The palette's Messages group: text search across threads from GET /api/v2/search.

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

async function boot(path = "/v2/thread/t1", width = 1280) {
  setViewportWidth(width);
  const app = renderApp(path);
  await waitFor(() => expect(shellSource()).toBeDefined());
  frame(() =>
    shellSource()?.emit("snapshot", shellSnapshot(5, [thread("t1", { title: "Fix the build" }), thread("t2", { title: "Deploy notes" })])),
  );
  return app;
}

const palette = () => screen.findByTestId("command-palette");
const modK = () => fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });

const match = (over: Partial<ThreadSearchMatch> = {}): ThreadSearchMatch => ({
  threadId: "t2",
  threadTitle: "Deploy notes",
  projectId: "w1",
  projectLabel: "alpha",
  archived: false,
  itemId: "a:0",
  role: "assistant",
  excerpt: "…rolled back the parser change after the deploy failed",
  ranges: [{ start: 17, end: 23 }],
  at: Date.now() - 60_000,
  ...over,
});

const requests: string[] = [];
function searchApi(results: ThreadSearchMatch[] | number = []) {
  requests.length = 0;
  server.use(
    http.get("/api/v2/search", ({ request }) => {
      const url = new URL(request.url);
      requests.push(`${url.searchParams.get("q")}|${url.searchParams.get("limit")}`);
      if (typeof results === "number") return new HttpResponse("nope", { status: results });
      return HttpResponse.json({ query: url.searchParams.get("q"), results, truncated: false });
    }),
  );
}

afterEach(() => {
  clearItemJump();
});

describe("palette: Messages", () => {
  it("searches after two characters and a pause, one request for a burst of typing", async () => {
    searchApi([match()]);
    await boot();
    modK();
    const dialog = await palette();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "p" } });
    await new Promise((r) => setTimeout(r, MESSAGE_SEARCH_DEBOUNCE_MS + 100));
    expect(requests).toEqual([]);
    fireEvent.change(input, { target: { value: "pa" } });
    fireEvent.change(input, { target: { value: "par" } });
    fireEvent.change(input, { target: { value: "pars" } });
    await within(dialog).findByText("Messages");
    expect(requests).toEqual(["pars|8"]);
  });

  it("shows the excerpt under the thread title with the matched words marked, You/Agent/Ran labels", async () => {
    searchApi([
      match(),
      match({ itemId: "u:0", role: "user", excerpt: "why does the parser crash", ranges: [{ start: 13, end: 19 }] }),
      match({ itemId: "c:0", role: "tool", excerpt: "grep -rn parser src/", ranges: [{ start: 9, end: 15 }] }),
    ]);
    await boot();
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "parser" } });
    const options = await within(dialog).findAllByRole("option", { name: /Deploy notes/ });
    expect(options).toHaveLength(3);
    const first = options[0]!;
    expect(first).toHaveTextContent("Agent:");
    expect(first.querySelector("mark")?.textContent).toBe("parser");
    expect(options[1]).toHaveTextContent("You:");
    expect(options[2]).toHaveTextContent("Ran:");
    // Phone-friendly rows: a 44 px target on touch, the excerpt clamped to two lines rather than overflowing.
    expect(first.className).toContain("pointer-coarse:min-h-11");
    expect(first.querySelector(".line-clamp-2")).not.toBeNull();
    expect(within(dialog).getByText("Messages")).toBeInTheDocument();
  });

  it("picking a result opens that thread and asks the timeline to jump to the item", async () => {
    searchApi([match()]);
    await boot();
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "parser" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Deploy notes/ }));
    await waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
    expect(useItemJumpStore.getState()).toMatchObject({ threadId: "t2", itemId: "a:0" });
    await waitFor(() => expect(document.querySelector("section[aria-label='Deploy notes']")).not.toBeNull());
  });

  it("Enter opens the first message when nothing else matches", async () => {
    searchApi([match({ itemId: "z:0" })]);
    await boot();
    modK();
    const dialog = await palette();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzparser" } });
    await within(dialog).findByRole("option", { name: /Deploy notes/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(useItemJumpStore.getState().itemId).toBe("z:0"));
  });

  it("the > actions filter does not search messages", async () => {
    searchApi([match()]);
    await boot();
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: ">parser" } });
    await new Promise((r) => setTimeout(r, MESSAGE_SEARCH_DEBOUNCE_MS + 150));
    expect(requests).toEqual([]);
    expect(within(dialog).queryByText("Messages")).toBeNull();
  });

  it("says so when nothing matches and when the search fails; an older bridge (404) stays quiet", async () => {
    searchApi([]);
    await boot();
    modK();
    const dialog = await palette();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: "qqqq" } });
    expect(await within(dialog).findByText(/No matching threads, projects, actions or messages/)).toBeInTheDocument();

    searchApi(500);
    fireEvent.change(input, { target: { value: "wwww" } });
    expect(await within(dialog).findByText("Message search failed.")).toBeInTheDocument();

    searchApi(404);
    fireEvent.change(input, { target: { value: "eeee" } });
    expect(await within(dialog).findByText(/No matching/)).toBeInTheDocument();
  });

  it("works on a phone-width screen", async () => {
    searchApi([match()]);
    await boot("/v2/thread/t1", 390);
    modK();
    const dialog = await palette();
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "parser" } });
    expect(await within(dialog).findByRole("option", { name: /Deploy notes/ })).toBeInTheDocument();
  });
});

describe("normalizeRanges", () => {
  it("clamps, drops empties, sorts and merges overlapping ranges", () => {
    expect(
      normalizeRanges("hello world", [
        { start: 6, end: 99 },
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 4, end: 4 },
        { start: -5, end: 0 },
      ]),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 11 },
    ]);
  });
});
