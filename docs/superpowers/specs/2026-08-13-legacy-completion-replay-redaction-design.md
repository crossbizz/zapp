# Legacy Completion Replay Redaction Design

## Problem

OPS-12 now redacts every model request at the last worker boundary. A durable
completion reserved before that change can already have reached Model Gateway
with an unredacted request fingerprint. Retrying the same completion ID with
redacted bytes produces a fingerprint conflict in Control API. Sending the old
bytes would leak a stored secret; assigning a new completion ID could execute or
bill the same turn twice.

## Chosen design

Version the durable in-flight request. Existing records without a version parse
as version 1. New records are version 2 and persist the exact redacted request
that will leave the worker.

For a version 1 replay whose redacted bytes differ, the worker sends a strict
`accountingReplay` field containing version `1` and the original durable
fingerprint. The completion ID does not change. Model Gateway accepts this
field only from the `orchestrator-worker` service identity, removes it before
provider routing, and uses the supplied fingerprint only for the existing
completion accounting claim.

This gives each possible prior state one safe outcome:

- Completed: Control API returns the already committed events and charges.
- Actively leased: Model Gateway returns the normal retryable lease result.
- Expired or uncommitted: the same accounting reservation is reclaimed, then
  the provider receives the redacted request.
- Fingerprint or tenant mismatch: Control API keeps returning a conflict.

The recovery field never appears in the public local-agent request schema and
Control API callers cannot submit it to Model Gateway.

## Alternatives rejected

Creating a second completion ID was smaller, but it could duplicate provider
work and billing after a post-claim worker crash. Marking every legacy request
failed closed was safe, but it broke the already shipped durable replay
contract. Rewriting accounting journal fingerprints lost the immutable record
of what originally claimed the completion.

## Boundaries

`services/orchestrator-worker/src/session/transcript.ts` owns durable version
compatibility. `services/orchestrator-worker/src/session/loop.ts` owns final
redaction and recovery metadata creation. Model Gateway schemas and the
authenticated internal route own admission. The accounting wrapper owns the
fingerprint override and must pass only a metadata-free `CompleteRequest` to
provider routing. Control API keeps its existing immutable fingerprint checks.

## Tests

One worker regression seeds a version 1 in-flight request and interrupts after
the first gateway claim. The resumed worker must keep the completion ID, send no
secret, and emit the legacy fingerprint marker. Model Gateway tests prove a
completed claim replays once, an expired claim resumes once, a Control API
caller is rejected, and the provider backend never receives `accountingReplay`.
Existing version 2 replay, usage accounting, budgets, and local-agent tests stay
green.

