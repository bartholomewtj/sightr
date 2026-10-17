// The Settings page's section chips (the phone version of T3 Code's SettingsSidebarNav, pattern only): a
// row of chips pinned under the page header, scrolling sideways when it is wider than the screen. A tap
// scrolls to the section; the chip of the section in view is marked. The page itself scrolls inside
// `[data-settings-page-scroll]` (settingsLayout), so the chips sit outside it and never move.
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export interface SettingsNavItem {
  id: string;
  label: string;
}

/** The last section whose top has reached the top of the page: the one being read. */
export function activeSection(tops: ReadonlyArray<{ id: string; top: number }>, pageTop: number, slack = 24): string | null {
  let active: string | null = tops[0]?.id ?? null;
  for (const t of tops) if (t.top - pageTop <= slack) active = t.id;
  return active;
}

export function SettingsNav({ items, onJump }: { items: readonly SettingsNavItem[]; onJump?: (id: string) => void }) {
  const [active, setActive] = useState<string | null>(items[0]?.id ?? null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const page = document.querySelector<HTMLElement>("[data-settings-page-scroll]");
    if (!page) return;
    const onScroll = () => {
      const tops = items.flatMap((i) => {
        const el = document.getElementById(i.id);
        return el ? [{ id: i.id, top: el.getBoundingClientRect().top }] : [];
      });
      setActive(activeSection(tops, page.getBoundingClientRect().top));
    };
    page.addEventListener("scroll", onScroll, { passive: true });
    return () => page.removeEventListener("scroll", onScroll);
  }, [items]);

  // Keep the active chip in view when the row scrolls sideways.
  useEffect(() => {
    navRef.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const jump = (id: string) => {
    setActive(id);
    onJump?.(id);
    // After a fold has opened and laid out.
    requestAnimationFrame(() => {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      document.getElementById(id)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    });
  };

  return (
    <nav ref={navRef} aria-label="Settings sections" className="border-b bg-background">
      <ul className="mx-auto flex max-w-4xl gap-1.5 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
        {items.map((item) => (
          <li key={item.id} className="shrink-0">
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(item.id);
              }}
              className={cn(
                "flex min-h-11 items-center rounded-full border px-3.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                active === item.id ? "border-foreground bg-accent text-foreground" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
