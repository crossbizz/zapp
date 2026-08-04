# 0003 — Sandbox file I/O binding and preview revocation

Status: accepted (controller ruling, 2026-08-03)
Affects: `packages/contracts/src/sandbox.ts` (FND-4), plan 03 tasks WS-4 and WS-12
References: PRD §18.2, §18.11, §18.13

## Context

FND-4 froze `CloudSandboxProvider` as the PRD §18.2 method set, verbatim. Two gaps in
that method set surfaced while writing the contracts:

1. **File operations are not workspace-scoped.** `exec(input: ExecInput)` targets a
   workspace (the input carries `providerWorkspaceId`), but `readFile(path)` and
   `writeFile(path, data)` take only a path. As written, an implementation has to bind
   file I/O to some implicitly attached workspace — state the rest of the interface
   does not have. `sandbox-service` runs as a stateless, horizontally replicated
   service (plan 03 §Scalability), so there is no such implicit workspace to bind to.
2. **Preview sessions have no revocation identifier.** PRD §18.11 requires preview
   sessions to be revocable and plan 03 WS-12 requires server-side revocation within
   10 s, but §18.2 exposes no `revokePreview`, so a token id on `PreviewHandle` would
   have nothing to call.

## Decision

Contracts v1 ships the PRD §18.2 method set **verbatim**, including both gaps, rather
than silently re-specifying a PRD interface inside a foundation task:

- `readFile(path)` / `writeFile(path, data)` keep their PRD signatures.
- `PreviewHandle` carries `{ providerWorkspaceId, url, expiresAt }` and no token id.

The corrections land with the plan that implements them, as plan amendments with the
PRD note attached:

- **WS-4** amends `CloudSandboxProvider` to workspace-scoped file operations —
  `readFile(providerWorkspaceId, path)` and `writeFile(providerWorkspaceId, path, data)`
  — matching `exec`'s addressing.
- **WS-12** adds `revokePreview(previewToken: string): Promise<void>` and the matching
  `previewToken` field on `PreviewHandle`.

Both amendments update `packages/contracts` and the plan text in the same commit, and
each records a PRD-deviation note (PRD §18.2 is the section that goes stale).

## Consequences

- FND-4 stays a faithful transcription of the PRD; no foundation task invents a
  provider interface the PRD does not describe.
- Plan 03 pays the cost: WS-4 and WS-12 each carry a contracts edit plus the downstream
  compile fixes, and both are `@zapp/contracts` version-visible changes for plans 04,
  05, 07 and 09.
- Until WS-12 lands, revocation is share-record-level only (delete the share record →
  the link stops working), which does not kill an already-issued provider connect token
  before its TTL expires. Preview TTLs must therefore stay short; WS-12 closes the gap.
- The two in-code comments in `packages/contracts/src/sandbox.ts` (on
  `CloudSandboxProvider` and `PreviewHandleSchema`) point here, so the next reader does
  not re-litigate the inconsistency.
