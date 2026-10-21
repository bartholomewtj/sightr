# T37 — The composer stays usable while the agent asks (T3 sync `688ee52`)

Status: built 21 Oct 2026. Depends on: T12 (composer), T04 (runtime requests). Web2 only: the bridge
already accepts a queued dispatch while a dialog is on screen.
Source: T3 Code `main` @ `688ee52f0e8f` (MIT), `#21503`. Ledger rows bumped in `web2/t3-upstream.json`.

## Problem

While the agent waits on a permission, trust, menu or question dialog, `ChatComposer` replaces the box
with the request panel. The operator cannot type the next instruction until they answer, and (per T12) a
send is refused with `needs-response` anyway.

T3 changed this: the composer stays usable during approvals, and a send declines the pending approvals
and redirects (queues) the message. Sightr can port the same *shape* — write now, the message waits —
but not the provider-level decline/redirect: Sightr's dialogs are parsed off the screen and answered by
option index, so there is no "decline" decision to send (spec T04; no harness id may drive it). The safe
Sightr form is: keep the box, and a send while a request is pending becomes a **queued** message, which
the bridge already stores and drains once the request is answered and the run rests. Nothing is declined
on the operator's behalf.

## Change

- `web2/src/components/chat/ChatComposer.tsx`: render the request panel **and** the composer box (the box
  below the panel), instead of the panel in the box's place. The box is disabled only for `readOnly` /
  link-loss / no-pane, not for a pending request.
- `web2/src/components/chat/ChatComposer.logic.ts` `resolveComposerButtons`: when `hasRequest`, the
  primary action is `queue` (label `Queue`) instead of a disabled Send + `requestPanel`, because `start`
  and `steer` are refused while a dialog is open (`needs-response`). A thread whose capabilities cannot
  queue keeps the disabled primary and the `Answer the agent above.` reason.
- `send(...)`: the `b.requestPanel` early-return is removed (the primary is already `queue`), so the
  mode passed to `dispatchMessage` is `queue`; the queued list, retry and slash-command paths share it.
  The bridge is the authority and accepts `queue` while blocked.
- The composer's status line says the message waits: "The agent is asking; your message is queued."
- The request panel keeps focus priority: the first option still takes focus on arrival, but focus returns
  to the box when the operator clicks it.

## Invariants

- No bridge change and no `shared/v2/contracts.ts` change: `mode: "queue"` is already accepted while
  `status` is `approval`/`input` or an open request exists (`bridge/threads/dispatch.ts` `enqueue`).
- A pending request is never auto-answered, declined or dismissed by a send; the operator answers it.
- While a request is pending, `steer` is never sent (the interrupt path would cancel the dialog).
- Existing behaviour is unchanged when no request is pending.

## Tests

- `ChatComposer.test.tsx`: with a pending permission request the box is present and the panel is present;
  typing and sending commits a `message.dispatch` with `mode: "queue"`, not `steer`/`start`; with no
  request the mode is unchanged.
- `ChatComposer.logic.test.ts`: with `hasRequest`, the primary is `queue` and `requestPanel` is true; a
  thread with no `canQueueDrain` keeps a disabled primary.
