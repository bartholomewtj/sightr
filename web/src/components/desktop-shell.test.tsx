import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { DesktopShell } from "./desktop-shell";
import { FilesRoute } from "@/routes/files";
import { __resetDesktop, desktopPrefs, setDesktop } from "@/lib/desktop";
import type { FilesData } from "@/lib/loaders";
import type { HomeData } from "@/lib/loaders";

const filesData: FilesData = { rel: "", data: { kind: "dir", path: "", entries: [], truncated: false } };

const data: HomeData = {
  bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [],
  error: false,
  authError: false, lastSeenAt: undefined, files: false,
};

beforeEach(() => { __resetDesktop(); setDesktop(true); });
afterEach(() => __resetDesktop());

it("renders the desktop outlet and sidebar navigation", async () => {
  const router = createMemoryRouter([{ id: "root", path: "/", loader: () => data, element: <DesktopShell />, children: [{ index: true, element: <div>pane stand-in</div> }] }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByRole("navigation", { name: "Desktop navigation" })).toBeInTheDocument());
  expect(screen.getByText("pane stand-in")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Desktop navigation" })).toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();
  expect((screen.getByRole("separator", { name: "Resize sidebar" }).parentElement?.parentElement as HTMLElement).style.gridTemplateColumns).toContain("280px");
});

it("clamps and persists a sidebar drag", async () => {
  const router = createMemoryRouter([{ id: "root", path: "/", loader: () => data, element: <DesktopShell />, children: [{ index: true, element: <div>pane stand-in</div> }] }], { initialEntries: ["/"] });
  const view = render(<RouterProvider router={router} />);
  const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 600 });
  expect(desktopPrefs().sidebarPx).toBe(480);
  view.unmount();
  render(<RouterProvider router={createMemoryRouter([{ id: "root", path: "/", loader: () => data, element: <DesktopShell />, children: [{ index: true, element: <div>pane stand-in</div> }] }], { initialEntries: ["/"] })} />);
  const remountedHandle = await screen.findByRole("separator", { name: "Resize sidebar" });
  expect((remountedHandle.parentElement?.parentElement as HTMLElement).style.gridTemplateColumns).toContain("480px");
});

it("keeps the phone files column capped but fills desktop width", async () => {
  __resetDesktop();
  const makeRouter = () => createMemoryRouter([{
    id: "root", path: "/", loader: () => ({ ...data, files: true }), element: <Outlet />,
    children: [{ path: "files", loader: () => filesData, element: <FilesRoute /> }],
  }], { initialEntries: ["/files"] });
  const phone = render(<RouterProvider router={makeRouter()} />);
  const phoneWrapper = (await screen.findByRole("searchbox")).closest(".mx-auto");
  expect(phoneWrapper).toHaveClass("max-w-screen-sm");
  phone.unmount();
  setDesktop(true);
  render(<RouterProvider router={makeRouter()} />);
  expect(await screen.findByText("Pick a file")).toBeInTheDocument();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
});
