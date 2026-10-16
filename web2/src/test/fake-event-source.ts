/**
 * A stand-in for `EventSource` (jsdom has none). Each instance records its URL; tests push frames with
 * `emit(name, data)` and fail it with `fail()`.
 */
type Listener = (event: { data?: string; lastEventId?: string; type: string }) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The most recent instance. */
  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource opened");
    return last;
  }

  /** Instances not closed yet. */
  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((es) => !es.closed);
  }

  readonly url: string;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: Listener): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(name: string, fn: Listener): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Deliver a named frame whose data is `JSON.stringify(data)` (or `raw` text as is). */
  emit(name: string, data?: unknown, opts: { raw?: string; id?: string } = {}): void {
    this.readyState = 1;
    const event = {
      type: name,
      data: opts.raw ?? (data === undefined ? "" : JSON.stringify(data)),
      lastEventId: opts.id ?? "",
    };
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }

  fail(): void {
    for (const fn of this.listeners.get("error") ?? []) fn({ type: "error" });
  }

  /** The `after` cursor this source was opened with, or null. */
  get after(): number | null {
    const v = new URL(this.url, "http://x").searchParams.get("after");
    return v === null ? null : Number(v);
  }
}

export const FakeEventSourceCtor = FakeEventSource as unknown as new (url: string) => EventSource;
