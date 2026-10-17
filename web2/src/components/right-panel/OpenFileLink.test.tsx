import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { useMessageToasts } from "@/components/toast";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { OpenFileLink, RESOLVE_REFUSED, splitPathLine } from "./OpenFileLink";

let asked: URL[] = [];

beforeEach(() => {
  asked = [];
  server.use(
    http.get("/api/files/resolve", ({ request }) => {
      const url = new URL(request.url);
      asked.push(url);
      const path = url.searchParams.get("path");
      if (path === "C:\\work\\proj\\src\\a.ts" || path === "src/a.ts") return HttpResponse.json({ path: "proj/src/a.ts", kind: "file" });
      if (path === "src") return HttpResponse.json({ path: "proj/src", kind: "dir" });
      return HttpResponse.json({ path: null, reason: "outside-root" });
    }),
  );
  act(() => useThreadStore.setState({ current: threadFromSnapshot(threadSnapshot(3, thread("t1")), false), missing: null }));
});

describe("OpenFileLink", () => {
  it("resolves a printed path against the thread's pane and opens it in the Files sheet on a phone", async () => {
    render(<OpenFileLink threadId="t1" path="src/a.ts:12" />);
    fireEvent.click(screen.getByRole("button", { name: "src/a.ts:12" }));
    await waitFor(() => expect(useRightPanelStore.getState().fileRequest).toMatchObject({ threadId: "t1", path: "proj/src/a.ts", kind: "file" }));
    expect(asked[0]?.searchParams.get("path")).toBe("src/a.ts");
    expect(asked[0]?.searchParams.get("pane")).toBe("p-t1");
    expect(useRightPanelStore.getState().sheet).toBe("files");
  });

  it("opens the desktop panel on the Files tab, and a folder as a folder", async () => {
    setViewportWidth(1280);
    act(() => useRightPanelStore.setState({ isOpen: false, activeSurfaceId: "git" }));
    render(<OpenFileLink threadId="t1" path="src">the src folder</OpenFileLink>);
    fireEvent.click(screen.getByRole("button", { name: "the src folder" }));
    await waitFor(() => expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "files", fileRequest: { path: "proj/src", kind: "dir" } }));
  });

  it("refuses a path outside the Files root with a clear message", async () => {
    render(<OpenFileLink threadId="t1" path="C:\Windows\win.ini" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(useMessageToasts.getState().toasts.map((t) => t.text)).toContain(RESOLVE_REFUSED["outside-root"]));
    expect(useRightPanelStore.getState().fileRequest).toBeNull();
  });

  it("splits a trailing line number but never a drive letter", () => {
    expect(splitPathLine("src/a.ts:12:3")).toEqual({ path: "src/a.ts", line: 12 });
    expect(splitPathLine("C:\\work\\a.ts")).toEqual({ path: "C:\\work\\a.ts" });
    expect(splitPathLine("C:\\work\\a.ts:7")).toEqual({ path: "C:\\work\\a.ts", line: 7 });
    expect(splitPathLine("C:12")).toEqual({ path: "C:12" });
    expect(splitPathLine(" a.ts ")).toEqual({ path: "a.ts" });
  });
});
