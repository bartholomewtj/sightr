/**
 * React's classic suspend-on-a-promise: throw the promise while it is pending so the nearest
 * `<Suspense>` boundary shows its fallback, rethrow a rejection so the boundary's error handler sees
 * it, and return the value once it has settled. Used by the lazily loaded renderers (the Mermaid
 * diagram, the KaTeX plugin), which each keep a module-level memo so only the first caller suspends.
 *
 * React 19's `use()` is the modern spelling, but it does not resume a suspended tree under this
 * repo's jsdom tests; a thrown promise does, in both environments.
 */
type TrackedPromise<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T };

export function suspendOn<T>(promise: Promise<T>): T {
  const tracked = promise as TrackedPromise<T>;
  if (tracked.status === undefined) {
    tracked.status = "pending";
    tracked.then(
      (value) => {
        tracked.status = "fulfilled";
        tracked.value = value;
      },
      () => {
        tracked.status = "rejected";
      },
    );
  }
  if (tracked.status === "pending") throw tracked;
  if (tracked.status === "rejected") throw new Error("the lazily loaded module failed");
  return tracked.value as T;
}
