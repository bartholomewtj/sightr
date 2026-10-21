# Windows smoke checklist

CI runs on Linux. Sightr is Windows-only: Task Scheduler, the PowerShell launcher, named pipes,
`icacls`, and WebAuthn on the real host are never exercised there. This is the manual pass that
covers them.

Run it **before tagging a release**, and again after a Herdr upgrade, a Windows feature update, or a
change to anything under `scripts/ctl/`, `contrib/windows/`, or the supervisor. Work on the host, not
a throwaway clone, unless a step says otherwise. Tick each box and note the date at the end.

## 1. Fresh-checkout install

- [ ] In a fresh clone (no `build/`), `herdr plugin link <path>` succeeds.
- [ ] The plugin's **Build** action runs at install (`herdr plugin install`) or on first `start`
      (a linked checkout), and `web/dist` + `web2/dist` both appear.
- [ ] Every plugin action runs through `contrib/windows/sightr-ctl.ps1` and reaches Bun — no missing
      launcher. (`start`, `stop`, `restart`, `status`, `update`, `uninstall` each return output.)

## 2. Lifecycle and supervisor

- [ ] `start` registers the `herdr.sightr` scheduled task, and the bridge listens on the loopback port.
- [ ] `stop` stops every bridge from this checkout and waits for the port to clear.
- [ ] `restart` brings it back and `status` reports "listening and answering".
- [ ] Kill `bun.exe` with `taskkill /F /IM bun.exe /T`: the PowerShell launcher relaunches after ~10 s
      and writes a `[launcher]` line to `sightr-error.log`.
- [ ] Block the bridge's `/api/snapshot` (or wedge it): after four failed probes the supervisor restarts
      it and writes a `[supervisor]` line. (Do not leave it wedged.)
- [ ] `uninstall` stops and disables the task, unregisters it, and removes the serve mapping, leaving
      the `.env` and checkout so `start` can bring it back.

## 3. Tailscale and access

- [ ] `tailscale serve` maps the HTTPS URL; the phone opens it and the shell loads.
- [ ] A host not in the allowlist gets **403 host not allowed** (try a made-up Host header).
- [ ] With `SIGHTR_TRUSTED_USER` set, a request with no matching identity header is refused.
- [ ] `status` reports whether the tailnet packet filter blocks inbound traffic.

## 4. The phone

- [ ] The PWA installs; reopening it picks up the current build (build swap) without clearing site data.
- [ ] The reconnect lock (Windows Hello / Face ID) prompts on return and unlocks.
- [ ] Push opt-in works per device, and a "needs input" push opens the right thread.
- [ ] A read-only device can watch but cannot write (send, rename, snooze, files edit all refuse).

## 5. The two apps and the v2 floor

- [ ] `/` serves v2; `/v1/` still serves the old app with its banner.
- [ ] With a Herdr older than 0.9.0, `/api/v2/*` answers **503 `herdr-too-old`** and v1 is unaffected.
      (Or note the host is on 0.9.0+ and this was not exercised.)
- [ ] `X-Sightr-Build` differs per UI and matches the build actually served.

## 6. Safety surfaces

- [ ] `audit.log` gets one JSON line per write, with the configured preview length.
- [ ] An upload is accepted by byte signature only; SVG is refused; a renamed non-image is refused.
- [ ] The Files tab is confined to `SIGHTR_WORK_ROOT` (try `..\` and an absolute path outside it).
- [ ] A corrupt `threads.sqlite` is moved aside as `.corrupt-<ts>` and a new store starts; v1 is unaffected.

## Sign-off

| Date | Version | Herdr | Windows | Checked by | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
