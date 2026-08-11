# ADR-0030: Meter Modal storage by persisted logical bytes

- Status: Accepted
- Date: 2026-08-11
- Owners: sandbox service / control plane / billing
- Approval: product-owner approval of OPS-2 review-round Option A, 2026-08-11
- Affects: Plan 10 OPS-2, sandbox snapshot creation, project-volume measurement
- References: PRD §30.1; ADR-0022

## Context

The pinned Modal JavaScript SDK 0.9.0 exposes neither an authoritative snapshot byte inventory nor
public snapshot/volume size APIs. A fake-only measurement port cannot satisfy OPS-2's production
metering requirement, while reading provider invoice totals cannot preserve project attribution.

## Decision

Sandbox-service captures logical bytes structurally at every snapshot creation and persists the
measurement with snapshot identity and expiry. It measures each project's persistent volume daily
by mounting it read-only in a temporary sandbox and running `du`. The control-plane collector bills
only a closed UTC day, under a distributed claim, from persisted snapshot measurements and the
volume probe result. A future provider billing export may reconcile operational/provider totals but
is not an OPS-2 runtime dependency.

## Consequences

Volume probes consume bounded Modal compute and must always terminate their temporary sandbox.
Logical bytes are the attributed product meter; provider-billed physical bytes may differ because
of compression, deduplication, and provider accounting windows. Observability and later provider
reconciliation must label that delta rather than rewriting the append-only project ledger.
