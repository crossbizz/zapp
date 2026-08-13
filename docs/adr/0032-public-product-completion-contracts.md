# ADR-0032: Public product completion contracts

**Status:** Accepted (product owner delegated execution authority, 2026-08-12)

## Context

The remaining P0 web and desktop tasks are blocked by capabilities that exist only as
internal service ports, workflow-local signals, or incomplete read models. Building those
screens against fixtures or direct internal endpoints would violate the API-first rule,
tenant isolation, and the prohibition on deriving workflow state from chat text.

The product owner instructed the team to do the required work and finish all remaining
tasks. This ADR records the minimum public contracts and durable state needed before the
clients are implemented.

## Decision

### Builder control and conversation

1. Mission Control returns server-computed action eligibility and stable reason codes.
2. Retry-failed-task and skip-optional-phase are keyed `/v1` mutations backed by Temporal
   signals. A phase is skippable only when its durable plan metadata declares it optional
   and no task in that phase has started. A task is retryable only from a terminal failed
   state after its dependencies remain satisfied.
3. Conversation cards are a discriminated, versioned contract carried by structured
   `AgentEvent` payloads. Interview answers and approval decisions use keyed public
   mutations; clients never parse assistant prose.
4. The existing run approval endpoint becomes a strict discriminated union covering the
   already-supported budget flow plus specification, plan, plan-diff, migration, and deploy
   decisions. Each decision must match the stored approval id and kind.

### Code, evidence, templates, and settings

5. Browser file access is a tenant-authorized control-plane bridge to sandbox-service.
   Direct edits use a compare token, create an attributed commit named
   `manual edit via web`, and never expose workspace service credentials.
6. Commit comparison and template seeding remain git-service responsibilities. Template
   creation accepts a registry slug; the server resolves its approved repository reference.
   Arbitrary client-supplied internal repository references are rejected.
7. Verification evidence is exposed as typed metadata plus bounded signed downloads through
   the artifact boundary. Test cases and artifacts remain tied to run, task, criterion, and
   organization identifiers.
8. Settings use public integration status/disconnect, member directory, GitHub sync, archive,
   and deletion operations. Secret values remain write-only.

### Deployment, desktop, and notifications

9. Deployment progress has its own durable deployment event stream and read model; it is not
   forced into run-scoped agent events. Public projections cover classification, confirmation,
   readiness actions, stage replay, success, history, health, synthetics, annotations,
   rollback compatibility, and custom domains.
10. Desktop Git uses a session-authenticated, audited, repository-scoped credential lease with
    a maximum five-minute lifetime. Credentials are injected per Git invocation and never
    stored in remotes or desktop state.
11. Docker mode consumes the provider-neutral `forge-node-base` recipe from an immutable
    public GHCR reference recorded as `tag@sha256:digest` in the image lock. CI publishes the
    mirror with the repository's GitHub token; runtime code never guesses a tag.
12. Desktop notifications consume an authenticated user projection with cursor replay. The
    update client accepts only signed stable/beta feed entries and treats update failure as
    non-fatal.

## Compatibility and safety

- All new boundaries use Zod schemas and generated SDK operations.
- Every mutation is idempotent or requires an `Idempotency-Key`.
- Cross-tenant and unauthorized resource reads return 404.
- New durable fields and event payloads default compatibly for existing histories.
- Internal service tokens, sandbox credentials, repository tokens, and provider identifiers
  never cross into browser or persisted desktop state.
- Real-provider acceptance remains a single final gate per owning task. Missing credentials
  remain visible skips or blockers, never passes.

## Consequences

The prerequisite work is larger than the original create-only UI file lists, but it removes
the documented blockers without client-private backdoors. Control-plane/OpenAPI/SDK changes
must be serialized. Web and desktop tasks may run independently only after their shared
contracts land.
