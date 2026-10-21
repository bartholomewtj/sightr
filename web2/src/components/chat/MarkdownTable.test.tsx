// Sightr's own test for the table copy formats (T35). The serializers are T3 Code's
// apps/web/src/markdown-clipboard.ts @ 688ee52f0e8f table halves; the menu is Sightr's.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownTable } from "./MarkdownTable";

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  setClipboard(writeText as unknown as (text: string) => Promise<void>);
});

function showTable() {
  return render(
    <MarkdownTable>
      <thead>
        <tr>
          <th>a</th>
          <th>b</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <code>x|y</code>
          </td>
          <td>2</td>
        </tr>
      </tbody>
    </MarkdownTable>,
  );
}

async function pick(format: "Copy as Markdown" | "Copy as CSV") {
  fireEvent.click(screen.getByRole("button", { name: "Copy table" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: format }));
}

describe("MarkdownTable", () => {
  it("renders the table in the scrolling container, collapsed", () => {
    const { container } = showTable();
    const wrapper = container.querySelector(".chat-markdown-table-container") as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("overflow-x-auto");
    expect(wrapper.getAttribute("data-expanded")).toBe("false");
    expect(wrapper.querySelector("table thead th")).toHaveTextContent("a");
    // Nothing is clipped in jsdom, so the wrap toggle stays out of the way.
    expect(screen.queryByRole("button", { name: "Expand table cells" })).toBeNull();
  });

  it("copies the table as Markdown, pipes in a cell escaped", async () => {
    showTable();
    await pick("Copy as Markdown");
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("| a | b |\n| --- | --- |\n| `x\\|y` | 2 |"),
    );
  });

  it("copies the table as CSV, from the cells' text", async () => {
    showTable();
    await pick("Copy as CSV");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("a,b\nx|y,2"));
  });

  it("quotes CSV cells that hold a comma or a quote", async () => {
    render(
      <MarkdownTable>
        <tbody>
          <tr>
            <td>one, two</td>
            <td>say "hi"</td>
          </tr>
        </tbody>
      </MarkdownTable>,
    );
    await pick("Copy as CSV");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('"one, two","say ""hi"""'));
  });
});
