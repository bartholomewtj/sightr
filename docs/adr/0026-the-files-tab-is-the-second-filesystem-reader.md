# ADR 0026: The Files tab is the second filesystem reader

Date: 2026-08-22

Status: **Accepted** (amended 2026-09-27)

> **Amended 2026-09-27 (spec 13).** The code moved on and this record now matches it. The env var is
> `SIGHTR_WORK_ROOT`. The module is no longer read-only: `/api/files/save` (editable text files) and
> `/api/files/delete` are part of the Files tab's job, under the same root, refusal list and
> containment. The containment helper lives in `bridge/containment.ts`, shared with the journal,
> not in `bridge/journal/`. HTML open is a unique-origin sandbox (ADR 0027), so "downloads are
> always `attachment`" now reads "downloads are `attachment`; open is ADR 0027's sandbox".

## Context

The journal (`bridge/journal/`) used to be the only thing in the bridge that touched the filesystem. A phone browser of the operator's work directory is a second reader, and it needs
the same containment terms. Serving a tree without opt-in would expose every deployment's
home; an extension allow-list fails open on unknown secrets; and inline downloads could execute an
HTML file from the work root same-origin with the bridge.

## Decision

Allow `bridge/workdir.ts` only when `SIGHTR_WORK_ROOT` is set. Every client path is relative, parsed
against the refusal list, and contained with `containedRealpath` (`bridge/containment.ts`) after
symlink resolution. Listings, previews, searches, and downloads have byte, depth, directory, result,
and entry caps. Refusals are indistinguishable from absent files. Save (editable text only) and
delete go through the same parse and containment. Downloads are `attachment`; open is ADR 0027.

## Consequences

The dot-name rule also hides useful folders such as `.adr`; this is the price of fail-closed behavior.
Save and delete are in scope (amended above). Send-to-pane from Files would still need a new ADR.
