# ADR 0026: The Files tab is the third filesystem reader

Date: 2026-08-22

Status: **Accepted**

## Context

ADR 0024 permits a second filesystem reader under strict containment terms. A phone browser of the
operator's work directory is a third. Serving a tree without opt-in would expose every deployment's
home; an extension allow-list fails open on unknown secrets; and inline downloads could execute an
HTML file from the work root same-origin with the bridge.

## Decision

Allow `bridge/workdir.ts` only when `COLLIE_WORK_ROOT` is set. Every client path is relative, parsed
against the refusal list, and contained with `containedRealpath` after symlink resolution. Listings,
previews, searches, and downloads have byte, depth, directory, result, and entry caps. Refusals are
indistinguishable from absent files. The module is read-only and downloads are always `attachment`.

## Consequences

The dot-name rule also hides useful folders such as `.adr`; this is the price of fail-closed behavior.
Making this writable or adding send-to-pane requires a new ADR.
