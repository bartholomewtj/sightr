import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/test/fake-event-source";
import { shellSnapshot, thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { frame, renderApp } from "@/test/render-app";

import { RenderErrorBoundary } from "./RenderErrorBoundary";

// A flag the mocks read: the thread timeline and the settings notifications group throw while it is set.
const crash = vi.hoisted(() => ({ timeline: false, settings: false }));

vi.mock("@/components/chat/MessagesTimeline", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/chat/MessagesTimeline")>();
  return {
    ...real,
    MessagesTimeline: (props: { threadId: string }) => {
      if (crash.timeline) throw new Error("malformed journal item");
      return <real.MessagesTimeline {...props} />;
    },
  };
});

vi.mock("@/components/settings/NotificationSettings", () => ({
  NotificationSettings: () => {
    if (crash.settings) throw new Error("settings blew up");
    return <p>notification settings</p>;
  },
}));

const shellSource = () => FakeEventSource.instances.find((es) => es.url.startsWith("/api/v2/shell"));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  crash.timeline = false;
  crash.settings = false;
  vi.restoreAllMocks();
});

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("boom");
  return <p>fine</p>;
}

describe("RenderErrorBoundary", () => {
  it("shows the fallback when a child throws, and the children when it does not", () => {
    const { rerender } = render(
      <RenderErrorBoundary fallback={<p>fallback</p>}>
        <Bomb explode={false} />
      </RenderErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
    rerender(
      <RenderErrorBoundary fallback={<p>fallback</p>}>
        <Bomb explode />
      </RenderErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeInTheDocument();
  });

  it("clears the failure when a reset key changes", () => {
    const tree = (key: string, explode: boolean) => (
      <RenderErrorBoundary resetKeys={[key]} fallback={<p>fallback</p>}>
        <Bomb explode={explode} />
      </RenderErrorBoundary>
    );
    const { rerender } = render(tree("a", true));
    expect(screen.getByText("fallback")).toBeInTheDocument();
    rerender(tree("a", false));
    expect(screen.getByText("fallback")).toBeInTheDocument();
    rerender(tree("b", false));
    expect(screen.getByText("fine")).toBeInTheDocument();
  });
});

describe("a render error in the app", () => {
  async function open(path: string) {
    setViewportWidth(800);
    const app = renderApp(path);
    await waitFor(() => expect(shellSource()).toBeDefined());
    frame(() => shellSource()!.emit("snapshot", shellSnapshot(10, [thread("a", { title: "Alpha" }), thread("b", { title: "Beta" })])));
    return app;
  }

  it("a throwing thread shows 'Something went wrong in this thread' with Reload and Back, and Back leaves", async () => {
    crash.timeline = true;
    const { router } = await open("/v2/thread/a");
    expect(await screen.findByText("Something went wrong in this thread")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/v2\/?$|^\/$/));
    expect(await screen.findByRole("navigation", { name: "Threads" })).toBeInTheDocument();
  });

  it("another thread opens normally after one failed", async () => {
    crash.timeline = true;
    const { router } = await open("/v2/thread/a");
    await screen.findByText("Something went wrong in this thread");
    crash.timeline = false;
    await router.navigate({ to: "/thread/$threadId", params: { threadId: "b" } });
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong in this thread")).toBeNull();
  });

  it("a route that throws outside a thread shows the router fallback, not a blank app", async () => {
    crash.settings = true;
    await open("/v2/settings");
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
  });
});
