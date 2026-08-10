# ADR-0027: Public conversation contract — message events, run continuation, attachments

- Status: Accepted
- Date: 2026-08-08
- Owners: control plane / agent runtime / web
- Approval: controller decision under the product owner's delegated authority, 2026-08-08 (same pattern as ADR-0009 and ADR-0021)
- Affects: FND-3 contracts (`packages/contracts/src/events.ts`), Plan 02 (new task CP-20), Plan 04 (new task AR-22), Plan 08 WEB-6
- References: product-owner API-first directive 2026-08-03; master Global Constraint 11 (no client parses chat text); PRD §10.0 (one continuous conversation), §14.1 (user-language activity), §23 (event/artifact tables); Plan 08 execution log 2026-08-06 and 2026-08-07 WEB-6 audits

## Context

WEB-6 (event-sourced conversation thread) was audited BLOCKED twice with the same
finding: the `AgentEvent` union (34 types on `main` at `9fcae48`) contains **no message
events**, tool events carry **no user-language `userSummary`**, and the generated `/v1`
SDK exposes **no run-continuation or attachment-upload operation**. Plan 08 consumes all
of these; no task in plans 02/04 was ever assigned to produce them. This is a plan-set
authoring gap, not an intended scope cut — the PRD's §10.0 continuous-conversation flow
requires a way to send a message into a run, and Global Constraint 11 requires the thread
to render from structured events. API-first correctly forbids the web client from
inventing a browser-private channel, so WEB-6 cannot self-serve.

## Decision

The public conversation contract is the following four parts, executed as **CP-20**
(plan 02) and **AR-22** (plan 04), both M1, ordered before WEB-6 in the tracker.

1. **Message events (additive `AgentEvent` types, persisted and sequenced like every
   event):**
   - `message.user` — `{ messageId, content (markdown), attachments: AttachmentRef[] (≤ 8), source: "web" | "desktop" | "api" }`
   - `message.assistant` — `{ messageId, turnId, content (markdown, inline ≤ 48 KB; larger content stored as an artifact and referenced by contentArtifactId), model }`
   - `tool.started` / `tool.completed` / `tool.failed` payloads gain a **required**
     `userSummary: string` (one user-language line, e.g. "Edited 3 files").
   - Assistant token-by-token deltas are **explicitly M2** (they need a transient,
     non-persisted channel decision that must not bloat `agent_events`). M1 threads
     render completed messages plus the existing `phase.*` / `tool.*` progress events.

2. **Continuation:** `POST /v1/runs/:runId/messages` `{ content, attachments? }` → 202
   `{ messageId, sequence }`. Idempotency-keyed; org-scoped (cross-tenant → 404);
   persists and emits `message.user` through CP-13 sequenced ingest and signals the AR-8
   run workflow. A run that cannot accept input returns the typed 409 `run_not_active`,
   and the client starts a new run per mode — exactly WEB-6's "continues run or starts
   new one" semantics.

3. **Attachments:** `POST /v1/projects/:projectId/attachments` (multipart, ≤ 8 MiB in
   M1) → `{ attachmentId, kind, name, byteSize, contentType }`, stored through the
   existing artifact conventions (tenant-prefixed R2 keys per FND-7, `artifact.created`
   event) — no new storage subsystem. `GET /v1/attachments/:attachmentId` returns a
   short-TTL signed URL. `AttachmentRef = { attachmentId, kind, name, byteSize, contentType }`.

4. **Emission is owned by the runtime, not the client:** AR-6/AR-8 emit `message.user`
   (initial prompt and every continuation), one `message.assistant` per completed
   assistant turn (retaining the session summary), populate `userSummary` on every tool
   event from the AR-4 registry's user-language templates, and emit `phase.*` at real
   phase boundaries.

## Consequences

- WEB-6 builds only against the regenerated SDK (CP-16 regen is part of CP-20); the
  desktop client (plan 09) inherits the identical contract.
- CP-13/CP-15 transport is unchanged — the new event types flow through sequenced
  ingest, SSE replay, and Last-Event-ID resume with no protocol work.
- The 48 KB inline cap keeps every event under the 64 KB payload bound (master §5.2)
  with artifact overflow for long assistant turns.
- WEB-4 Slice B stays governed by ADR-0021's exit condition (a versioned project-summary
  read model) — deliberately **not** expanded here; that read model is a separate
  decision when Mission Control read models (AR-13) land in M2.
- OpenAPI changes are additive only; the CP-16 breaking-change detector must stay green.
