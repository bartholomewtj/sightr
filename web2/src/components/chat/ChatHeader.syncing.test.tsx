import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";

// Live 18 Oct 2026 at 360 px: "Syncing…" sat in the title row and squeezed the thread title to a few
// letters. It is now a thin line on the header's bottom edge, outside the row's flow.

beforeEach(() => {
  installListLayout();
  setViewportWidth(360);
});

const source = (prefix: string) => FakeEventSource.instances.find((es) => es.url.startsWith(prefix));

describe("thread header while syncing", () => {
  it("shows syncing as a status line out of the title row, and drops it once synchronized", async () => {
    renderApp("/v2/thread/t1");
    await waitFor(() => expect(source("/api/v2/shell")).toBeTruthy());
    const t1 = threadFixture("t1", {
      title: "A long thread title that needs the room",
      capabilities: { ...threadFixture("t1").capabilities, hasJournal: true },
    });
    frame(() => source("/api/v2/shell")?.emit("snapshot", shellSnapshot(5, [t1])));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Syncing…");
    // Absolutely placed on the header's edge: it takes no width from the title.
    expect(status.className).toMatch(/\babsolute\b/);
    const header = status.closest("header") as HTMLElement;
    expect(header).toBeTruthy();
    expect(within(header).queryByText("Syncing…", { selector: "span:not(.sr-only)" })).toBeNull();

    await waitFor(() => expect(source("/api/v2/thread")).toBeTruthy());
    frame(() => source("/api/v2/thread")?.emit("synchronized", { sequence: 5 }));
    await waitFor(() => expect(header.querySelector("[data-syncing]")).toBeNull());
  });
});
