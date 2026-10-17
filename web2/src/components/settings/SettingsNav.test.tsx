import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { activeSection, SettingsNav } from "./SettingsNav";

describe("activeSection", () => {
  const tops = [
    { id: "a", top: 100 },
    { id: "b", top: 600 },
    { id: "c", top: 1200 },
  ];
  it("is the first section until a later one reaches the top", () => {
    expect(activeSection(tops, 100)).toBe("a");
    expect(activeSection(tops, 90)).toBe("a");
  });
  it("is the last section whose top has reached the page top", () => {
    expect(activeSection(tops.map((t) => ({ ...t, top: t.top - 560 })), 100)).toBe("b");
    expect(activeSection(tops.map((t) => ({ ...t, top: t.top - 1200 })), 100)).toBe("c");
  });
  it("is null with no sections", () => {
    expect(activeSection([], 0)).toBeNull();
  });
});

describe("SettingsNav", () => {
  it("a chip calls onJump and scrolls its section into view", async () => {
    const onJump = vi.fn();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(
      <>
        <SettingsNav
          items={[
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ]}
          onJump={onJump}
        />
        <section id="one" />
        <section id="two" />
      </>,
    );
    expect(screen.getByRole("link", { name: "One" })).toHaveAttribute("aria-current", "location");
    fireEvent.click(screen.getByRole("link", { name: "Two" }));
    expect(onJump).toHaveBeenCalledWith("two");
    expect(screen.getByRole("link", { name: "Two" })).toHaveAttribute("aria-current", "location");
    await vi.waitFor(() => expect(scroll.mock.contexts.some((el) => (el as HTMLElement).id === "two")).toBe(true));
    scroll.mockRestore();
  });
});
