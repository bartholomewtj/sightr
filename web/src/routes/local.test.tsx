import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { LocalRoute } from "./local";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

const home: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [],
  device: undefined, files: true, error: false, authError: false,
};

const local = { host: "bart.tailab17af.ts.net", servers: [{ port: 3080, name: "local models" }, { port: 8787, name: "sightr" }] };

/** Counts every GET /api/local-servers and answers with `body` (or a 500 when `fail`). */
function serveLocal(body: { host: string; servers: { port: number; name: string }[] } = local, fail = false): { count: () => number } {
  let n = 0;
  server.use(http.get("/api/local-servers", () => { n += 1; return fail ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(body); }));
  return { count: () => n };
}

function renderLocal() {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => home, element: <Outlet />,
    children: [{ path: "local", element: <LocalRoute /> }],
  }], { initialEntries: ["/local"] });
  return render(<RouterProvider router={router} />);
}

describe("LocalRoute", () => {
  it("makes no request until Scan is tapped, then exactly one", async () => {
    const calls = serveLocal();
    renderLocal();
    expect(await screen.findByText("Tap Scan to list the servers listening on this PC.")).toBeInTheDocument();
    expect(screen.getByText("Not scanned yet")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(calls.count()).toBe(0);

    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    const row = await screen.findByRole("link", { name: /local models/ });
    expect(row).toHaveAttribute("href", "http://bart.tailab17af.ts.net:3080/");
    expect(row).toHaveAttribute("target", "_blank");
    expect(row).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: /sightr/ })).toHaveAttribute("href", "http://bart.tailab17af.ts.net:8787/");
    expect(screen.getByText(":3080")).toBeInTheDocument();
    expect(screen.getByText(/^Scanned /)).toBeInTheDocument();
    expect(calls.count()).toBe(1);
  });

  it("shows the last scan on reopen without a request", async () => {
    const calls = serveLocal();
    const first = renderLocal();
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    await screen.findByRole("link", { name: /local models/ });
    first.unmount();

    renderLocal();
    expect(await screen.findByRole("link", { name: /local models/ })).toHaveAttribute("href", "http://bart.tailab17af.ts.net:3080/");
    expect(calls.count()).toBe(1);
  });

  it("labels an unnamed port with the fallback", async () => {
    serveLocal({ host: "host.example", servers: [{ port: 5555, name: "" }] });
    renderLocal();
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    const row = await screen.findByRole("link", { name: /port 5555/ });
    expect(row).toHaveAttribute("href", "http://host.example:5555/");
  });

  it("says Tailscale isn't running when the host is empty", async () => {
    serveLocal({ host: "", servers: [] });
    renderLocal();
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    expect(await screen.findByText("Tailscale isn't running on this PC")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is listening on localhost.")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says nothing is listening when the host is up and the list is empty", async () => {
    serveLocal({ host: "host.example", servers: [] });
    renderLocal();
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    expect(await screen.findByText("Nothing is listening on localhost.")).toBeInTheDocument();
    expect(screen.queryByText("Tailscale isn't running on this PC")).toBeNull();
  });

  it("keeps the last list and shows an error when a scan fails", async () => {
    serveLocal();
    renderLocal();
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    await screen.findByRole("link", { name: /local models/ });
    serveLocal(undefined, true);
    await userEvent.click(await screen.findByRole("button", { name: /scan/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /scan/i })).toBeEnabled());
    expect(screen.getByRole("link", { name: /local models/ })).toBeInTheDocument();
    expect(screen.getByText(/500|Couldn't list local servers/)).toBeInTheDocument();
  });
});
