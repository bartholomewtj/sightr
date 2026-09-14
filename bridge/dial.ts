// Dial shim for herdr's control socket. On Windows the ".sock" path herdr reports is a pointer
// file — the actual transport is a named pipe whose name is the full socket path
// (\\.\pipe\C:\...\herdr.sock). node:net opens named pipes by name, and this adapts it to the
// handler shape the two call sites in herdr-client.ts use (write/flush/end only).
//
// There is NO application-level handshake — herdr's `interprocess` local sockets carry the raw
// bytes ("Interprocess never inserts its own message framing or any other type of metadata into
// the stream"), so newline-delimited JSON-RPC goes straight over the pipe.
import net from "node:net";

export type SockHandle = {
  /**
   * Hand a whole payload to the socket. Backpressure is the DIALER's problem, not the caller's:
   * node:net queues whatever the kernel won't take and flushes it itself, so every byte is either
   * delivered or the connection fails loudly through `error`/`close`. Never returns a byte count —
   * there is nothing for a caller to retry.
   */
  write(data: string): void;
  flush(): void;
  /**
   * Closes the connection IMMEDIATELY — this is destroy(), not a graceful half-close, so
   * queued-but-unflushed data may be dropped. That is correct for both current consumers (one-shot
   * RPCs close only after the reply line arrives; the event stream uses it to cancel), but do not
   * reuse this handle anywhere that needs written data drained on close.
   */
  end(): void;
};

export type DialHandlers = {
  open?(s: SockHandle): void;
  data?(s: SockHandle, chunk: Uint8Array): void;
  error?(s: SockHandle, err: Error): void;
  close?(s: SockHandle): void;
  /**
   * Invoked synchronously during dialHerdr() with a canceller that aborts the dial even while it
   * is still connecting. The returned promise alone cannot do that — there is no handle to close
   * until `open` — so a caller-side timeout that fires mid-connect would otherwise leak the
   * pending OS handle until the connect itself resolves or fails.
   */
  onDial?(cancel: () => void): void;
};

/**
 * herdr names its pipe after the full socket path. Pass through a value that is already a pipe
 * name (either slash direction) so an explicit HERDR_SOCKET_PATH=\\.\pipe\… works.
 */
export function toPipeName(socketPath: string): string {
  if (socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("//./pipe/")) {
    return socketPath;
  }
  return "\\\\.\\pipe\\" + socketPath;
}

export function dialHerdr(socketPath: string, handlers: DialHandlers): Promise<SockHandle> {
  // node:net addresses a named pipe by name on win32 and an AF_UNIX path elsewhere — only the
  // former needs the `\\.\pipe\` mapping. The fallback keeps the test suite runnable off Windows.
  const address = process.platform === "win32" ? toPipeName(socketPath) : socketPath;
  return new Promise<SockHandle>((resolve, reject) => {
    const sock = net.connect(address);
    // `write()` here is all-or-nothing at the API level — it queues whatever the kernel won't take
    // and returns a BOOLEAN (false = "buffered, back off"), never a partial byte count, and flushes
    // the queue itself. Failures still surface through the 'error'/'close' handlers below, which is
    // what rejects a request that dies mid-write.
    const handle: SockHandle = {
      write: (data) => {
        sock.write(data);
      },
      flush: () => {},
      end: () => sock.destroy(),
    };
    let opened = false;
    handlers.onDial?.(() => sock.destroy());
    sock.on("connect", () => {
      opened = true;
      handlers.open?.(handle);
      resolve(handle);
    });
    sock.on("data", (chunk: Buffer) => handlers.data?.(handle, chunk));
    sock.on("error", (err) => {
      if (!opened) reject(err);
      handlers.error?.(handle, err as Error);
    });
    sock.on("close", () => {
      // A dial destroyed while still connecting emits close without error; settle the promise so
      // no caller is left awaiting forever. Guarded rejects/finishes upstream make this a no-op
      // when the caller already timed out.
      if (!opened) reject(new Error("dial closed before connect"));
      handlers.close?.(handle);
    });
  });
}
