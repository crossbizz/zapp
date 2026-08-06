# ADR-0005: Temporary desktop provider-call migration window

- Status: Accepted — controller decision 2026-08-04
- Date: 2026-08-04
- Owners: Agent runtime / macOS app

## Context

Master plan Global Constraint 2 says, “No direct model-provider calls outside
`services/model-gateway`.” AR-1 now introduces that gateway, but the Dyad code
imported by MAC-1 already contains direct provider construction and completion
calls in `apps/desktop/src/ipc/utils/get_model_client.ts` and
`apps/desktop/src/ipc/services/provider_api_key_validation_service.ts`.

Plan 09 deliberately schedules replacement of the desktop agent path in MAC-6.
MAC-6 packages the AR-6 session loop for local execution and sends every model
call through the platform model gateway, explicitly stating that Global
Constraint 2 then holds. MAC-6 is an M2 task that consumes work built after
AR-1, so requiring the migration before AR-1 can complete creates a dependency
cycle. Leaving the inherited calls undocumented would silently weaken an
absolute master-plan constraint.

Repository inspection at the immutable AR-1 parent anchor
`df81175a82ed9cb2d7508caafd291a2c26bc4794` finds eight runtime
provider/completion consumer paths, not only the two examples above:

- `apps/desktop/src/ipc/handlers/chat_stream_handlers.ts`
- `apps/desktop/src/ipc/handlers/compaction/compaction_handler.ts`
- `apps/desktop/src/ipc/handlers/help_bot_handlers.ts`
- `apps/desktop/src/ipc/services/provider_api_key_validation_service.ts`
- `apps/desktop/src/ipc/utils/get_model_client.ts`
- `apps/desktop/src/ipc/utils/llm_engine_provider.ts`
- `apps/desktop/src/ipc/utils/ollama_provider.ts`
- `apps/desktop/src/ipc/utils/stream_text_utils.ts`

The same anchor also contains non-type provider SDK imports in
`apps/desktop/src/ipc/utils/provider_options.ts`. The mechanical boundary
therefore inventories nine exact inherited production paths: the eight
runtime consumer paths plus that import-only path. This audit correction does
not permit a new path or event; the baseline remains derived from the same
commit and tree.

## Proposed decision

Permit a temporary, development-only exception for the direct provider call
sites that already exist under `apps/desktop` at the AR-1 parent commit. The
exception ends when MAC-6 lands and never extends to new call sites, web code,
cloud execution, or any service other than `services/model-gateway`.

Enforce the migration window with an exact-path architecture check that:

- allows only the inherited desktop files recorded above;
- fails if another file outside `services/model-gateway` imports an AI SDK
  provider package or invokes a provider completion API;
- records any growth within an allowlisted file as a reviewed baseline change;
- becomes a zero-exception rule in the same commit that completes MAC-6.

No production distribution may pass the P0 release gate while the exception is
active. AR-1 may complete once its own provider-neutral API contract and tests
pass, because the accepted exception makes the pre-existing desktop debt
explicit and bounded.

## Consequences

- AR-1 no longer depends on the later MAC-6 migration, preserving the written
  milestone dependency order.
- The desktop keeps its inherited provider paths during development, including
  their local-key and provider-specific behavior. They receive no new product
  investment and remain outside the supported zapp agent path.
- MAC-6 must route desktop model traffic and key validation through the model
  gateway, remove or isolate the inherited provider constructors, and delete
  the architecture-check exceptions before it can be marked done.
- The M2 exit checklist must fail if any direct provider exception remains.
- Until MAC-6 lands, reviewers must describe the repository as having a bounded
  desktop migration exception, not as globally satisfying Constraint 2.

## Rejected alternatives

- Migrate the desktop during AR-1: MAC-6 depends on the AR-6 loop and WS-1 local
  runtime work and is intentionally a later, invasive Dyad replacement task.
- Delete the inherited desktop paths immediately: this would break imported
  desktop behavior before its zapp replacement exists and would widen AR-1 far
  beyond its binding Files contract.
- Block AR-1 and all dependent agent-runtime work until MAC-6: MAC-6 consumes
  the agent runtime built by those tasks, producing a dependency cycle rather
  than reducing risk.
