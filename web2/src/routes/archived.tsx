import { createFileRoute, Link } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { useShell } from "@/stream/stores";

// T10 builds the archived list (read-only threads, unarchive). This is the plain version meanwhile.
export const Route = createFileRoute("/archived")({
  component: Archived,
});

function Archived() {
  const threads = useShell(
    useShallow((s) =>
      Object.values(s.threads)
        .filter((t) => t.shelf === "archived")
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
    ),
  );
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto p-4">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        Back to threads
      </Link>
      <h1 className="text-xl font-semibold">Archived</h1>
      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No archived threads.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {threads.map((t) => (
            <li key={t.id}>
              <Link to="/thread/$threadId" params={{ threadId: t.id }} className="block px-4 py-2 text-sm hover:bg-accent">
                {t.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
