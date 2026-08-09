# ADR-0025 — Durable model completions precede authoritative usage accounting

**Status:** Accepted (controller-delegated execution, 2026-08-09)

## Context

AR-3 became a hard prerequisite when the M1 Anthropic credential was configured. Its
original task cannot be completed safely in its published order:

- AR-3 tells model-gateway to append `usage_ledger` directly, while the later OPS-1 task
  owns the service-authenticated usage route, transactional outbox, and Flexprice path.
  A direct writer would permanently bypass authoritative rating and wallets.
- Temporal retries a model turn with the same logical identity. If accounting commits but
  the worker dies before saving the transcript, calling the provider again can produce a
  different response and different usage under the same key. Token-row idempotency alone
  cannot replay the lost response.
- Redis is a hot mirror, not attribution truth. Recovering only spent credits and deriving
  a new ceiling from `spent + remaining` can increase a run's absolute budget after an
  eviction or restart.
- The original AR-3 Files list excludes the gateway, orchestrator, control-api, database,
  queue, and contract joins needed to close those windows. Two capped review rounds on
  2026-08-09 reproduced all three defects.

The task is therefore split at load-bearing service boundaries instead of opening another
review round on the same shape.

## Decision

Execute the prerequisite sequence **AR-3A → OPS-1A → AR-3B** before any further real model
traffic.

### AR-3A — Stable completion identity and terminal envelope

- The orchestrator derives `completionId` from `(runId, taskId, transcript.turns)` before
  each model call and durably stores one `inFlightCompletion` containing that ID, the full
  validated gateway request (including `maxOutputTokens`), and its token reservation before
  dispatch. A retry reuses that exact object instead of recomputing a smaller request from
  already-reserved tokens. The record is cleared only when the turn is durably committed;
  the next committed turn gets a different identity.
- The production `TranscriptStore` for the M1 Temporal activity is the latest validated
  transcript in Temporal heartbeat details, not process memory. Every successful transcript
  compare-and-swap immediately heartbeats the complete checkpoint; an activity retry on a
  fresh worker seeds its store from that server-side checkpoint. The existing periodic
  heartbeat remains only a liveness refresh. The checkpoint has a strict serialized-size cap
  below Temporal's payload limit and compacts or fails closed before crossing it. A real
  child-worker kill/restart test must prove that the saved request and reservation survive
  process loss.
- The gateway request requires that identity. Provider adapters normalize every terminal
  finish reason and always surface provider/model-attributed usage before a terminal
  success or typed error.
- `stop` and `tool-calls` may terminate successfully. `length` maps to the explicit
  `output_limit_exceeded` budget outcome; error/content-filter/unknown terminal outcomes
  remain billable typed errors. None is represented as `done`.

### OPS-1A — Durable completion journal and authoritative usage ingest

Control-api owns strict service-authenticated internal boundaries:

- `POST /internal/model-completions/claim`
- `POST /internal/model-completions/:completionId/commit`
- `GET /internal/model-completions/:completionId`
- `POST /internal/runs/:runId/credit-ceiling-increases`

A tenant-scoped `model_completion_journal` stores the replayable neutral response events,
the normalized terminal outcome, the stable request fingerprint, a short renewable claim
lease, and the completion's bounded worst-case credit reservation. Claim locks the run
accounting row and atomically reserves the maximum charge for the exact request and complete
configured retry/fallback route before any provider attempt. Insufficient unreserved credit
returns `budget_exceeded` without dispatch. Repeated claims for the same completion reuse the
same reservation. The commit transaction:

1. locks the run's accounting domain;
2. verifies the completion claim and request fingerprint;
3. appends deterministic input/output/cached-token ledger rows, distinguishing cache reads
   and writes with the existing ledger `unit` field;
4. records the replayable terminal completion;
5. replaces the outstanding reservation with actual charged credits, releasing unused
   credit, and computes the authoritative running total; and
6. appends a transactional usage-outbox entry for the existing OPS-1 SQS/Flexprice path.

The transaction result is idempotent by `completionId`. Usage already incurred is always
recorded, including terminal provider failures. A run has an immutable base ceiling plus an
append-only `run_credit_ceiling_adjustments` history. The increase route requires a resolved
approval, an idempotent operation key, and a strictly greater absolute ceiling; it can never
decrease or rewrite history. The effective ceiling is the latest approved absolute ceiling,
or the immutable base when no adjustment exists. Redis mirrors authoritative
`{ used, reserved, ceiling, version }`
under `run:{runId}:credits`. Reconciliation reads active runs only, uses bounded batches and
one database leader lease, and can never manufacture a ceiling or adjustment. A database
commit followed by Redis loss is healed from the same authoritative rows.

OPS-1A also closes the uncapped-run and rating gaps before provider dispatch.
`config/pricing.json` contains a positive `defaultRunCreditCeiling`, versioned provider/model
token rates, and explicit cache-read/cache-write units for M1. Public run creation resolves an
omitted budget to that configured value and persists the resolved absolute ceiling plus an
immutable pricing-version snapshot; an absent or invalid ceiling/rate fails before workflow
or provider dispatch. That local snapshot is authoritative for this run's reservations,
ledger credits, and execution cutoff. Flexprice remains authoritative for organization wallet
rating, entitlements, and billing; asynchronous vendor drift is reconciled but never changes
an in-flight run's historical rate snapshot. OPS-3 later replaces the single default ceiling
with tenant plan entitlements without changing the completion API.

OPS-1A also supplies the SQS publisher/consumer path required for these outbox records, so
AR-3B has no direct database or vendor call. OPS-1B later adds the remaining bootstrap,
summary, compensating-entry, and full-category acceptance without changing this route.

### AR-3B — Gateway accounting, replay, telemetry, and prompt caching

- Model-gateway claims and obtains its atomic worst-case reservation before provider
  dispatch. A completed claim replays the journal and does not call the provider. A live
  foreign claim returns a typed retryable response; an exhausted reservation returns the
  terminal budget outcome without calling a provider.
- It may stream deltas while collecting them, but commits the complete neutral response and
  usage before emitting `usage.recorded` and terminal `done`/error. A retry after commit is
  therefore byte-for-byte replayable and unbilled twice.
- It calls only the OPS-1A client; model-gateway has no Postgres, Redis, SQS, or Flexprice
  dependency.
- OTel records every provider attempt, including missing usage and terminal errors.
- Anthropic's explicit cache breakpoint follows the stable role prompt **and assembled
  project context**, not the role prompt alone. Final acceptance performs the one allowed
  real-provider write/read proof and verifies cached input tokens reach the authoritative
  usage response.

## Consequences

- AR-3's old direct-ledger implementation shape is rejected; its recoverable local stash is
  input to the new tasks, not a completion candidate.
- The model completion journal intentionally stores model output because replay requires
  it. It is tenant scoped, never logged, subject to the run/transcript retention policy,
  and contains no provider credentials.
- The extra tables are P0 execution state, so FND-6's exact schema inventory and migration
  tests must be updated in OPS-1A.
- OPS-1 is split into OPS-1A (authoritative write/reservation path, pulled into M1) and
  OPS-1B (remaining Flexprice bootstrap/read-model acceptance in M2).
- This decision changes ordering and interfaces only; Flexprice, Postgres, Redis, SQS,
  Temporal, and the provider-adapter boundary remain locked.
