import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useDropUpload } from "./use-drop-upload";
import * as api from "@/lib/api";
import { DirectTypingStrip } from "@/components/direct-typing-strip";
import { __resetPasteHold, pasteHold, setPasteHold } from "@/lib/paste-hold";
import { useStatus } from "@/lib/status";

const uploadImage = vi.fn();
function drop(files: File[] = [], text = "") {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, getData: () => text } });
  window.dispatchEvent(event);
  return event;
}
function dragover() {
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}
function Probe({ enabled = true, onPath = vi.fn() }: { enabled?: boolean; onPath?: (path: string) => void }) {
  const handlePath = (path: string) => {
    setPasteHold({ kind: "path", path, onSend: () => { setPasteHold(null); onPath(path); }, onDiscard: () => setPasteHold(null) });
  };
  useDropUpload({ paneId: "w:p", enabled, onPath: handlePath, uploadImage });
  const status = useStatus();
  return <><DirectTypingStrip onStop={vi.fn()} /><output>{status?.text}</output></>;
}
function DefaultProbe() {
  const onPath = vi.fn();
  useDropUpload({ paneId: "w:p", enabled: true, onPath });
  const status = useStatus();
  return <><DirectTypingStrip onStop={vi.fn()} /><output>{status?.text}</output></>;
}

describe("useDropUpload", () => {
  beforeEach(() => { __resetPasteHold(); uploadImage.mockReset(); });
  afterEach(() => __resetPasteHold());

  it("prevents file drops, uploads the image, and holds its path until Type path", async () => {
    uploadImage.mockResolvedValue("/host/shot.png");
    const onPath = vi.fn();
    render(<Probe enabled onPath={onPath} />);
    expect(dragover().defaultPrevented).toBe(true);
    expect(drop([new File(["x"], "shot.png", { type: "image/png" })]).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Type path" })).toBeInTheDocument());
    expect(pasteHold()?.kind).toBe("path");
    expect(onPath).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Type path" }));
    expect(onPath).toHaveBeenCalledWith("/host/shot.png");
  });

  it("reports failed default uploads without holding a path", async () => {
    vi.spyOn(api, "uploadImage").mockResolvedValue({ ok: false, error: "Upload rejected" });
    render(<DefaultProbe />);
    act(() => drop([new File(["x"], "shot.png", { type: "image/png" })]));
    await waitFor(() => expect(screen.getByText("Upload rejected")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Type path" })).not.toBeInTheDocument();
    expect(pasteHold()).toBeNull();
  });

  it("ignores text drops", () => {
    render(<Probe />);
    expect(drop([], "https://example.test").defaultPrevented).toBe(true);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(pasteHold()).toBeNull();
  });

  it("reports non-image drops without uploading or holding", () => {
    render(<Probe />);
    act(() => drop([new File(["x"], "notes.txt", { type: "text/plain" })]));
    expect(screen.getByText("Only images can be dropped")).toBeInTheDocument();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(pasteHold()).toBeNull();
  });

  it("does not attach listeners when disabled", () => {
    const add = vi.spyOn(window, "addEventListener");
    render(<Probe enabled={false} />);
    expect(add).not.toHaveBeenCalledWith("dragover", expect.anything());
    expect(add).not.toHaveBeenCalledWith("drop", expect.anything());
    expect(dragover().defaultPrevented).toBe(false);
    expect(drop([new File(["x"], "shot.png", { type: "image/png" })]).defaultPrevented).toBe(false);
    expect(uploadImage).not.toHaveBeenCalled();
    add.mockRestore();
  });
});
