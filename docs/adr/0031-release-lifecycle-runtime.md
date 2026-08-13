# ADR-0031: Make the release lifecycle a callable service

- Status: Accepted
- Date: 2026-08-12
- Owners: release plane / control plane
- Approval: product-owner instruction to re-scope proven blockers and continue, 2026-08-12
- Affects: Plan 07 DEP-12, control-api production composition, release-service runtime

## Context

DEP-12 requires the public `/v1` release lifecycle to be live from candidate creation
through readiness, approval, deployment, evidence, rollback, and release repair. The
original two-file allowance cannot deliver that contract: `services/release-service`
has no listening application or production composition, its internal routes expose only
create/get/approve, and `services/control-api` still binds the unavailable release port.
A control-plane fake would make the public API report success without a callable release
plane, which is forbidden by the API-first and failed-check honesty constraints.

## Decision

DEP-12 may modify the minimum additional files needed to make the existing architecture
real:

1. add the release-service application, environment, server, lifecycle composition, and
   validated internal lifecycle routes;
2. add one service-authenticated control-api HTTP client implementing the unchanged
   six-method `ReleasePort`, plus a separately named release-repair fork port so
   ADR-0012 remains intact;
3. bind that client in deployed control-api composition and fail closed outside local
   development when `RELEASE_SERVICE_URL` is absent;
4. cover the public lifecycle through the real control-api → release-service transport,
   with the Fly staging journey gated once at final acceptance.

The 2026-08-12 capped review established that transport and injected ports do not by
themselves satisfy “fully live.” Execution is therefore split without weakening the
exit: DEP-12a lands the authenticated transport, public SDK, atomic release audit, and
structural deploy gate; DEP-12b must bind the concrete DEP-2–11 adapters into an
executable process and replace the transport fixture with the real Postgres/Temporal/
provider/VF-15/rollback/repair/synthetic acceptance journey. DEP-12 stays unchecked
until DEP-12b and the original final gate are complete.

Provider implementations, state machines, and public route names remain those already
fixed by Plans 05–07. This ADR authorizes wiring and runtime scope, not a replacement
provider, alternate deployment path, or browser-private API.

## Consequences

- The task's Files contract expands explicitly; every touched file must belong to the
  transport, runtime, public contract generation, or executable acceptance path.
- Internal request and response bodies are Zod-validated on both sides, and every
  mutation carries the caller's operation key.
- Release repair stays separate from the six-method `ReleasePort` and creates the exact
  `fix/rel-{releaseId}` branch at the immutable release commit.
- DEP-12a's local Fastify/provider fixture proves transport only and cannot be cited as
  E16/E17/E18; DEP-12b owns the real composed acceptance journey. The real Fly provider
  is invoked only by the env-gated final acceptance.
