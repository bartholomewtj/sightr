# 23 — Local servers tab

Status: done — #73, `b0e11aa`. Not a council slice. One run.

Amended after #73: the tab no longer polls. Each poll tick re-ran the loader, and every read shells out to PowerShell on the PC, so the tab cost a process spawn every 1.5–4 s while open. The list is now read only when the operator taps **Scan**; the route has no loader (`web/src/lib/local-scan.ts`), and the last scan is kept in the phone's local storage. The Web and Tests sections below describe the original build.

## What the operator gets

A fourth destination in the phone's bottom bar, **Local**, between Files and Settings. It lists the servers currently listening on this PC's loopback and opens each one in a new browser tab.

A row reads `local models` on the left and `:3080` on the right, and tapping it opens `http://bart.tailab17af.ts.net:3080/`. The list is whatever is listening right now, so a dev server started after the page opened appears within a few seconds, and one that stops disappears.

## Why it looks like this

The phone cannot open `localhost` and reach the PC — `localhost` on the phone is the phone. A small forwarder already running on the PC (`%APPDATA%\loopfwd\loopfwd.js`, scheduled task `Loopfwd`) mirrors each loopback port onto the PC's Tailscale address. So the same port number works from the phone at `http://<tailscale-host>:<port>/`. This tab is the index for that.

The bare hostname `bart.tailab17af.ts.net` is already Sightr's own front door (`tailscale serve` → `127.0.0.1:8787`) and must not be touched. Links therefore always carry an explicit port.

## Bridge

New read-only route `GET /api/local-servers`. No new config, no new env var, no writes.

Response:

```json
{ "host": "bart.tailab17af.ts.net", "servers": [ { "port": 3080, "name": "local models" } ] }
```

- `host` is the machine's own Tailscale DNS name, read from `tailscale status --json` (`Self.DNSName`, trailing dot stripped). Cache it; refresh at most once a minute. If Tailscale isn't reachable or the name can't be read, return `host: ""` and `servers: []` with status 200 — the tab then shows "Tailscale isn't running on this PC", not an error page.
- `servers` is every TCP port in state Listen whose address is `127.0.0.1` or `::1`, minus 443 (owned by `tailscale serve`). Sorted by port ascending. Deduped.
- `name` comes from a fixed map, and is `""` when the port isn't in it: `3080` local models, `4877` node, `8787` sightr, `9222` chrome devtools, `9333` chrome, `18787` thickapi, `32400` plex.
- Discovering ports shells out to `powershell.exe -NoProfile -Command` running `Get-NetTCPConnection -State Listen`. Follow the pattern `bridge/` already uses for a shell-out (see how the Files routes and `scripts/ctl` spawn). Bound the command with a timeout. On failure, return the last good list rather than emptying the tab.

The route sits behind the same access check as every other bridge route. It adds nothing to `audit.log` — it reads no operator content.

## Web

- `web/src/lib/nav.ts`: add `localPath()` → `/local`.
- `web/src/lib/loaders.ts`: a `localLoader` that fetches `/api/local-servers` and returns `{ host: string; servers: { port: number; name: string }[]; error?: string }`. A poll revalidation should re-run it (unlike `filesShouldRevalidate`), because the list changes on its own. Abort errors rethrow, same as `filesLoader`.
- `web/src/router.tsx`: route `local` with that loader and a `LocalRoute`.
- `web/src/routes/local.tsx`: the screen. Header "Local". One row per server: the name, falling back to `port <n>` when `name` is empty, and the port on the right. The row is an `<a target="_blank" rel="noreferrer">` to `http://<host>:<port>/`. Empty host shows the Tailscale message above. Empty servers shows "Nothing is listening on localhost."
- `web/src/components/bottom-nav.tsx`: add the item. Icon `Server` from `lucide-react`. Order: Spaces, Files (when shown), Local, Settings. Lit when `pathname.startsWith("/local")`.
- `web/src/routes/root.tsx`: extend `showNav` so the bar stays up on `/local`.

Match the Files screen's layout, spacing and header rather than inventing a new one. The tab is phone-only; desktop has no bottom bar and needs nothing.

## Tests

Colocated, in the style of the neighbouring test files:

- Bridge: the port parser. Given canned `Get-NetTCPConnection` output, it keeps loopback listeners, drops `0.0.0.0` and `::`, drops 443, dedupes, sorts, and names known ports. A failed shell-out returns the previous list.
- `bottom-nav.test.tsx`: Local renders and navigates to `/local`.
- `routes/local.test.tsx`: rows render with the right `href`, an unnamed port gets the fallback label, and the two empty states render.

## Out of scope

- Do not edit `loopfwd`, the scheduled task, or anything under `%APPDATA%`.
- Do not change `tailscale serve`, `SIGHTR_SERVE_MODE`, or port 443.
- Do not add an env var, a config key, or a write route.
- Do not add a `CONTEXT.md` or `DECISIONS.md` row. Do not add an ADR.
- Do not implement any other spec in this run.

## Done when

`bun run test` at the repo root is green, and the web tests for the touched files are green. `CHANGELOG.md` Unreleased gets one line: the Local tab lists the PC's loopback servers and opens them over the tailnet.
