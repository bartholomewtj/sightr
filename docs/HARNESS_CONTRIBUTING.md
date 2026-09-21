# Adding a harness

This file exists so older ADR and adapter comments still resolve.

How to add a harness is [README.md → Development](../README.md#development) (“Adding a harness”). The CI gate is [`web/src/lib/harness/conformance.ts`](../web/src/lib/harness/conformance.ts): dated pane captures under `web/src/fixtures/panes/`, `describeAdapterConformance`, and per-adapter tests. Keep Herdr JSON-RPC method names inside `bridge/herdr-client.ts`.
