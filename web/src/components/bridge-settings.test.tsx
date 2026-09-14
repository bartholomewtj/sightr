import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { BridgeSettings } from "@/components/bridge-settings";

let patch: Record<string, unknown> | undefined;
let current = { deviceAllowlist: ["phone", "laptop"], notifyDelayMs: 30000, submitKeys: ["Enter"], readLines: 200 };
beforeEach(() => {
  patch = undefined;
  current = { deviceAllowlist: ["phone", "laptop"], notifyDelayMs: 30000, submitKeys: ["Enter"], readLines: 200 };
  server.use(
    http.get("/api/settings", () => HttpResponse.json(current)),
    http.post("/api/settings", async ({ request }) => { patch = await request.json() as Record<string, unknown>; current = { ...current, ...(patch as Partial<typeof current>) }; return HttpResponse.json(current); }),
  );
});

describe("BridgeSettings", () => {
  test("renders four fetched values and saves only changed read lines", async () => {
    const user = userEvent.setup(); render(<BridgeSettings />);
    const lines = await screen.findByRole("spinbutton", { name: "Read lines" });
    expect(lines).toHaveValue(200);
    expect(screen.getByRole("textbox", { name: "Device allowlist" })).toHaveValue("phone, laptop");
    expect(screen.getByRole("spinbutton", { name: "Notify delay" })).toHaveValue(30000);
    expect(screen.getByRole("textbox", { name: "Submit keys" })).toHaveValue("Enter");
    await user.clear(lines); await user.type(lines, "500"); await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toEqual({ readLines: 500 }));
    expect(lines).toHaveValue(500);
    expect(screen.getByRole("textbox", { name: "Device allowlist" })).toHaveValue("phone, laptop");
  });
  test("shows a bridge validation reason and reverts the draft", async () => {
    const user = userEvent.setup(); server.use(http.post("/api/settings", () => new HttpResponse("bad readLines", { status: 400 })));
    render(<BridgeSettings />); const lines = await screen.findByRole("spinbutton", { name: "Read lines" });
    await user.clear(lines); await user.type(lines, "20"); await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/bad readLines/)).toBeInTheDocument()); expect(lines).toHaveValue(200);
  });
  test("readOnly disables all controls", async () => {
    render(<BridgeSettings readOnly />); await screen.findByRole("textbox", { name: "Device allowlist" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    for (const name of ["Device allowlist", "Notify delay", "Submit keys", "Read lines"]) expect(screen.getByRole(name === "Notify delay" || name === "Read lines" ? "spinbutton" : "textbox", { name })).toBeDisabled();
  });
  test("confirms removing this device before posting", async () => {
    const user = userEvent.setup(); render(<BridgeSettings device={{ enforced: true, device: "phone", authorized: true }} />);
    const allow = await screen.findByRole("textbox", { name: "Device allowlist" });
    await user.clear(allow); await user.type(allow, "laptop"); await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("This removes this phone's access.")).toBeInTheDocument(); expect(patch).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(patch).toEqual({ deviceAllowlist: ["laptop"] }));
  });
  test("removing another device does not confirm", async () => {
    const user = userEvent.setup(); render(<BridgeSettings device={{ enforced: true, device: "phone", authorized: true }} />);
    const allow = await screen.findByRole("textbox", { name: "Device allowlist" }); await user.clear(allow); await user.type(allow, "phone");
    await user.click(screen.getByRole("button", { name: "Save" })); await waitFor(() => expect(patch).toEqual({ deviceAllowlist: ["phone"] }));
    expect(screen.queryByText("This removes this phone's access.")).not.toBeInTheDocument();
  });
});
