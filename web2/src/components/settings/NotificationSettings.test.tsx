import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENDPOINT_KEY, IOS_INSTALL_NOTE } from "@/lib/push";
import { installFakePush, uninstallFakePush, VAPID } from "@/test/push";
import { server } from "@/test/setup";

import { NotificationSettings } from "./NotificationSettings";
import { PushOnboarding } from "./PushOnboarding";
import { useShell } from "@/stream/stores";

let subscribed: Record<string, unknown>[] = [];
let prefsPosts: Record<string, unknown>[] = [];
let prefs = { blocked: true, done: false };

beforeEach(() => {
  subscribed = [];
  prefsPosts = [];
  prefs = { blocked: true, done: false };
  vi.stubEnv("BASE_URL", "/v2/");
  server.use(
    http.get("/api/config", () => HttpResponse.json({ push: true, vapidPublicKey: VAPID })),
    http.post("/api/subscribe", async ({ request }) => {
      subscribed.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ ok: true });
    }),
    http.get("/api/notifications/prefs", () => HttpResponse.json(prefs)),
    http.post("/api/notifications/prefs", async ({ request }) => {
      const patch = (await request.json()) as Record<string, boolean>;
      prefsPosts.push(patch);
      prefs = { ...prefs, ...patch };
      return HttpResponse.json(prefs);
    }),
  );
});

afterEach(() => {
  uninstallFakePush();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "userAgent");
});

const pushSwitch = () => screen.getByRole("switch", { name: "Push notifications" });
// Base UI's switch is a span: disabled is aria-disabled.
const off = (el: HTMLElement) => expect(el).toHaveAttribute("aria-disabled", "true");
const on = (el: HTMLElement) => expect(el).not.toHaveAttribute("aria-disabled", "true");

describe("NotificationSettings: push on this device", () => {
  it("turns push on through web2's worker, replacing the v1 endpoint, and off again", async () => {
    installFakePush();
    localStorage.setItem(ENDPOINT_KEY, "https://push.example/v1-endpoint");
    render(<NotificationSettings readOnly={false} />);
    await waitFor(() => on(pushSwitch()));
    expect(pushSwitch()).not.toBeChecked();
    fireEvent.click(pushSwitch());
    await waitFor(() => expect(pushSwitch()).toBeChecked());
    expect(subscribed).toEqual([expect.objectContaining({ replaces: "https://push.example/v1-endpoint" })]);
    fireEvent.click(pushSwitch());
    await waitFor(() => expect(pushSwitch()).not.toBeChecked());
    expect(localStorage.getItem("sightr:push-disabled")).toBe("1");
  });

  it("shows v1's failure text when the subscribe fails", async () => {
    installFakePush();
    server.use(http.post("/api/subscribe", () => new HttpResponse(null, { status: 403 })));
    render(<NotificationSettings readOnly={false} />);
    await waitFor(() => on(pushSwitch()));
    fireEvent.click(pushSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent("This device isn't authorised to change notification settings.");
    expect(subscribed).toHaveLength(0);
  });

  it("an iPhone not installed to the Home Screen gets the install note", async () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    render(<NotificationSettings readOnly={false} />);
    expect(await screen.findByText(IOS_INSTALL_NOTE)).toBeInTheDocument();
    off(pushSwitch());
  });

  it("read-only: the switch is disabled and says why", async () => {
    installFakePush();
    render(<NotificationSettings readOnly />);
    await waitFor(() => expect(screen.getByText("This device isn't authorised to change notification settings.")).toBeInTheDocument());
    off(pushSwitch());
  });
});

describe("NotificationSettings: notify when (all devices)", () => {
  it("loads the bridge's prefs and round-trips a toggle", async () => {
    installFakePush();
    render(<NotificationSettings readOnly={false} />);
    const finished = await screen.findByRole("switch", { name: "Finished" });
    await waitFor(() => on(finished));
    expect(screen.getByRole("switch", { name: "Needs input" })).toBeChecked();
    expect(finished).not.toBeChecked();
    fireEvent.click(finished);
    await waitFor(() => expect(prefsPosts).toEqual([{ done: true }]));
    await waitFor(() => expect(finished).toBeChecked());
  });

  it("read-only devices see the prefs but cannot change them", async () => {
    installFakePush();
    render(<NotificationSettings readOnly />);
    const finished = await screen.findByRole("switch", { name: "Finished" });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Needs input" })).toBeChecked());
    off(finished);
  });

  it("hides the notify rows when the bridge has no VAPID keys", async () => {
    installFakePush();
    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })));
    render(<NotificationSettings readOnly={false} />);
    expect(await screen.findByText(/no VAPID keys configured/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Finished" })).toBeNull();
  });
});

describe("PushOnboarding", () => {
  it("offers push once the shell is loaded, and Not now holds it back", async () => {
    installFakePush();
    useShell.setState({ loaded: true });
    const { unmount } = render(<PushOnboarding />);
    expect(await screen.findByRole("button", { name: "Turn on notifications" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("push-onboarding")).toBeNull();
    unmount();
    render(<PushOnboarding />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("push-onboarding")).toBeNull();
  });

  it("Turn on subscribes and closes the card", async () => {
    installFakePush();
    useShell.setState({ loaded: true });
    render(<PushOnboarding />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    await waitFor(() => expect(screen.queryByTestId("push-onboarding")).toBeNull());
    expect(subscribed).toHaveLength(1);
  });
});
