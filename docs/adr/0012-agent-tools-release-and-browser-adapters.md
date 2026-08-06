# ADR-0012: Agent-tool release and browser adapters

- Status: Accepted
- Date: 2026-08-06
- Owners: Agent runtime / release service / verification service
- Approval: product-owner delegated controller decision, 2026-08-06
- Affects: AR-4, DEP-1
- References: PRD §16.1–§16.3, Plan 04 AR-4, Plan 07 DEP-1

## Context

The initial AR-4 implementation replaced Plan 07's `ReleasePort` with a tool-shaped
interface that mixed release lifecycle, previews, smoke tests, and deployment health.
It also let browser tools provide absolute URLs. That contract was incompatible with
DEP-1 and let model input select destinations outside an attributed zapp preview or
deployment.

## Decision

`ReleasePort` retains exactly the DEP-1 method set:
`createReleaseCandidate`, `getReadiness`, `approve`, `deploy`, `rollback`, and
`getEvidence`. Agent-tools injects trusted project attribution and supplies optional
call options containing its code-derived idempotency key, trusted execution context,
and `AbortSignal`; implementations that perform mutations must deduplicate that key.

Tool-only preview and verification operations use separately named narrow ports:

- `PreviewToolPort` owns preview creation and preview smoke execution.
- `DeploymentHealthPort` owns deployment-health evidence.
- `BrowserEvidencePort` owns browser tests, screenshots, console evidence, and
  network evidence.

Browser model schemas accept only a preview or deployment identifier and an
origin-relative route. The browser/verification service resolves the identifier to
an attributed origin and must reject any redirect whose destination is outside that
same resolved origin. Agent-tools never accepts or constructs an arbitrary absolute
browser destination.

## Consequences

- DEP-1 can implement its planned release lifecycle without preview or health methods
  being added to `ReleasePort`.
- Preview, smoke, health, and browser implementations remain service-owned adapters;
  agent-tools performs no browser, deployment-provider, or release-provider calls.
- Mutating service calls are traceable to trusted run/task/step context and can return
  a consistent result after retries or ambiguous cancellation by deduplicating the
  supplied key.
- Absolute URL support would require a future reviewed boundary change rather than a
  model-schema expansion.
