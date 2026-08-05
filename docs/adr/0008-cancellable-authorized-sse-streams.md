# ADR-0008: Cancellable and continuously authorized SSE streams

- Status: Accepted — controller decision 2026-08-04
- Date: 2026-08-04
- Owners: Control plane / data access

## Context

CP-15's original file contract can stop awaiting a stalled event replay, but the
tenant repository exposes only an ordinary `Promise`. Drizzle hides the
postgres.js `PendingQuery.cancel()` handle, so abandoning that promise leaves a
query and pool connection alive and can still block production database
shutdown. The original route also authorizes only when a four-hour stream opens
and has no concurrent-stream ceiling, allowing revoked sessions to keep reading
and authenticated callers to exhaust Redis or PostgreSQL connections.

## Decision

Expand CP-15's internal file contract and preserve its public API:

- `EventRange` accepts an optional `AbortSignal`; the postgres.js-backed event
  repository executes replay through a cancel-capable pending query and maps a
  caller abort to `AbortError` after sending PostgreSQL's cancellation request.
- The app composes a stream revalidator from the existing token denylist,
  access-token expiry, and organization membership store. Active streams run it
  every 60 seconds and fail closed on revocation, removal, expiry, or lookup
  failure.
- Each API process enforces concurrent ceilings of 8 streams per user, 64 per
  organization, and 256 total before allocating a Redis subscription. Tests may
  inject lower limits, but production cannot disable any tier.

The database query remains tenant-filtered and parameterized. No unscoped
database handle crosses into the route layer.

## Consequences

- CP-15 may touch the database tenant repository and client type, app/run-route
  composition, and their tests in addition to its original SSE files.
- Revocation propagation is bounded to 60 seconds rather than the four-hour
  connection lifetime.
- Per-process ceilings bound dedicated Redis subscribers and fallback polling;
  future multiplexing may raise the limits without changing the public route.
- A cancelled event replay rejects internally with `AbortError`; stream shutdown
  contains it and never reports a closed connection as an application failure.

## Rejected alternatives

- Racing and abandoning the Drizzle promise: it releases the HTTP handler but
  not the PostgreSQL query or pool connection.
- A database shutdown timeout alone: it does not release queries when clients
  disconnect during normal service operation.
- Authorize only at connection open: logout and membership removal would remain
  ineffective for up to four hours.
- Rely on the request-rate limiter: a rate limit bounds opens per minute, not the
  number of long-lived sockets, Redis subscribers, or fallback pollers.
