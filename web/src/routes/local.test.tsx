import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";

import { LocalRoute } from "./local";
import { ROOT_ROUTE_ID, type HomeData, type LocalData } from "@/lib/loaders";

const home: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [],
  device: undefined, files: true, error: false, authError: false,
};

function renderLocal(data: LocalData) {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => home, element: <Outlet />,
    children: [{ path: "local", loader: () => data, element: <LocalRoute /> }],
  }], { initialEntries: ["/local"] });
  return render(<RouterProvider router={router} />);
}

describe("LocalRoute", () => {
  it("renders a row with the right href", async () => {
    renderLocal({
      host: "bart.tailab17af.ts.net",
      servers: [{ port: 3080, name: "local models" }, { port: 8787, name: "sightr" }],
    });
    const row = await screen.findByRole("link", { name: /local models/ });
    expect(row).toHaveAttribute("href", "http://bart.tailab17af.ts.net:3080/");
    expect(row).toHaveAttribute("target", "_blank");
    expect(row).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: /sightr/ })).toHaveAttribute("href", "http://bart.tailab17af.ts.net:8787/");
    expect(screen.getByText(":3080")).toBeInTheDocument();
  });

  it("labels an unnamed port with the fallback", async () => {
    renderLocal({ host: "host.example", servers: [{ port: 5555, name: "" }] });
    const row = await screen.findByRole("link", { name: /port 5555/ });
    expect(row).toHaveAttribute("href", "http://host.example:5555/");
  });

  it("says Tailscale isn't running when the host is empty", async () => {
    renderLocal({ host: "", servers: [] });
    expect(await screen.findByText("Tailscale isn't running on this PC")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is listening on localhost.")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says nothing is listening when the host is up and the list is empty", async () => {
    renderLocal({ host: "host.example", servers: [] });
    expect(await screen.findByText("Nothing is listening on localhost.")).toBeInTheDocument();
    expect(screen.queryByText("Tailscale isn't running on this PC")).toBeNull();
  });
});
