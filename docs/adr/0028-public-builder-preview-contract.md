# ADR-0028: Public builder preview contract

- Status: Accepted
- Date: 2026-08-10
- Owners: control plane / sandbox / web
- Approval: product-owner delegated authority in the 2026-08-10 instruction to complete WEB-7–11 and any required APIs
- Affects: Plan 02 CP-21, Plan 08 WEB-7 and WEB-11
- References: API-first directive 2026-08-03; ADR-0023; Plan 03 WS-12/WS-13; Plan 08 WEB-7

## Context

WEB-7 consumes authenticated previews produced by WS-12 and lifecycle/log data produced by
WS-13. The public API currently exposes share management and workspace lifecycle, but the
dev-server log/restart operations remain service-only and proxy capture events are reachable
only through the preview transport. A browser implementation would therefore have to call
`sandbox-service` directly, carry a service credential, or fabricate preview state. All three
violate API-first and the credential boundary.

The internal interfaces are already structural and sufficient: sandbox-service owns the
workspace attribution, server-authoritative execution contract, bounded log ring, preview
proxy SSE, and screenshot endpoint. The missing work is a tenant-scoped public projection and
generated client surface, not a second preview system.

## Decision

CP-21 adds the following versioned public operations. Every operation resolves the workspace
through the tenant repository first; another tenant and an unknown workspace both return 404.
No response includes a provider workspace id, sandbox-service origin, Modal URL, service token,
or preview bearer.

1. `GET /v1/workspaces/:workspaceId/dev-server/logs?after=<cursor>&limit=<n>` returns
   `{ entries: [{ cursor, at, stream, message }], nextCursor, truncated, state, failureId }`.
   `after` defaults to `0`; `limit` defaults to `100` and is capped at `1000`.
2. `POST /v1/workspaces/:workspaceId/dev-server/restart` is idempotency-keyed and accepts no
   execution contract from the browser. The control plane loads the project's latest stored
   contract, validates it with `ExecutionContractSchema`, and forwards it with the attributed
   workspace. A missing contract returns typed `409 project_contract_unavailable`.
3. `GET /v1/workspaces/:workspaceId/preview/events` is an authenticated, cancellable SSE
   pass-through for the workspace's preview-proxy `/__zapp/events`. The control plane supplies
   service authentication and attribution; the browser supplies neither. Captures retain the
   WS-10 contract and never include request or response bodies.
4. `POST /v1/workspaces/:workspaceId/preview/screenshot` is idempotency-keyed and proxies the
   WS-10 screenshot trigger. A base image's structural `501` remains visible and is never
   rewritten as success.
5. The regenerated SDK adds the ordinary log/restart/screenshot operations plus
   `subscribePreviewEvents(workspaceId, handlers)`, matching the cancellation/error behavior of
   `subscribeRunEvents` without sharing cursors between the two streams.

WEB-7 discovers `workspaceId` only from structured `preview.*` events, creates/uses WS-12 share
records through the SDK, renders the share URL in the iframe, and consumes all operational
state through these CP-21 operations. `window.postMessage` remains reserved for WS-10 route and
element-selection messages; it is not a substitute for the public capture stream.

## Consequences

- sandbox-service remains internal and retains the only service/provider credentials.
- Restart cannot be redirected to a client-supplied command or contract.
- WEB-7 can render starting, ready, stale, disconnected, and failed states from durable events,
  live logs, and capture records without parsing chat text.
- WEB-11 reuses the same log operation; file/diff/test surfaces require their own contract and
  are deliberately outside this ADR.

