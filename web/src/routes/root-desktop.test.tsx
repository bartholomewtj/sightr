import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { __resetDesktop, setDesktop, setLayout } from "@/lib/desktop";
import type { HomeData } from "@/lib/loaders";
import { RootLayout } from "./root";

vi.mock("@/hooks/use-polling", () => ({ usePolling: vi.fn() }));
vi.mock("@/hooks/use-transitions", () => ({ useAgentTransitions: vi.fn() }));
vi.mock("@/hooks/use-push", () => ({ usePushSetup: vi.fn(), usePushDevice: vi.fn(() => ({ seen: false, readOnly: false })) }));
vi.mock("@/hooks/use-poll-busy", () => ({ usePollBusy: vi.fn() }));
vi.mock("@/components/connection-banner", () => ({ ConnectionBanner: () => null }));

const data: HomeData = {
  bridge: "connected", device: undefined, agents: [], shellPanes: [], workspaces: [], tabs: [],
  error: false,
  authError: false, files: true,
};

beforeEach(() => __resetDesktop());
afterEach(() => __resetDesktop());

function renderRoot() {
  const router = createMemoryRouter([{
    id: "root", path: "/", loader: () => data, element: <RootLayout />, children: [
      { index: true, element: <div>Phone outlet</div> },
    ],
  }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

it("uses the phone outlet and BottomNav when desktop mode is off", async () => {
  renderRoot();
  await waitFor(() => expect(screen.getByText("Phone outlet")).toBeInTheDocument());
  expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  expect(screen.queryByText("Desktop mode is on")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Desktop navigation" })).not.toBeInTheDocument();
});

it("uses DesktopShell when System matches the desktop query", async () => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  try {
    setLayout("system");
    renderRoot();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Desktop navigation" })).toBeInTheDocument());
  } finally { window.matchMedia = original; }
});

it("uses the phone layout when System does not match", async () => {
  setLayout("system");
  renderRoot();
  await waitFor(() => expect(screen.getByText("Phone outlet")).toBeInTheDocument());
  expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
});

it("keeps Off pinned even when the desktop query matches", async () => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  try {
    setDesktop(false);
    renderRoot();
    await waitFor(() => expect(screen.getByText("Phone outlet")).toBeInTheDocument());
    expect(localStorage.getItem("sightr:desktop:v2")).toContain('"layout":"off"');
  } finally { window.matchMedia = original; }
});

const filesData: HomeData = {
  ...data,
  files: true,
  workspaces: [{
    workspaceId: "w1", number: 1, label: "home", focused: false, activeTabId: "t1", tabCount: 1, paneCount: 1,
  }],
};

function renderFilesRoot(path: string) {
  const router = createMemoryRouter([{
    id: "root", path: "/", loader: () => filesData, element: <RootLayout />, children: [
      { path: "files", element: <div>list</div> },
      { path: "files/*", element: <div>preview</div> },
    ],
  }], { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

it("keeps the phone bottom bar on the Files list", async () => {
  renderFilesRoot("/files");
  await waitFor(() => expect(screen.getByText("list")).toBeInTheDocument());
  expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
});

it("hides the phone bottom bar on a file preview", async () => {
  renderFilesRoot("/files/src/nav.ts");
  await waitFor(() => expect(screen.getByText("preview")).toBeInTheDocument());
  expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
});

