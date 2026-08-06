# ADR-0010: Modal image publishing boundary

- Status: Accepted — controller decision 2026-08-05
- Date: 2026-08-05
- Owners: Workspace runtime / sandbox service / infrastructure
- Affects: WS-2, WS-4, WS-14

## Context

The master plan requires every direct Modal SDK call to live in
`services/sandbox-service`. Plan 03 repeats that architecture and reserves
`src/provider/modal.ts` as the only Modal SDK import site. WS-2, however,
originally described the TypeScript files under `infra/modal/images` as Modal
SDK image builders and assigned publishing to `infra/modal/publish.ts` before
WS-4 creates the sandbox-service package.

Reading the WS-2 file contract literally would therefore violate the higher
precedence master constraint. Moving all image ownership into the service would
also erase the plan's explicit `infra/modal` ownership and make the lock file a
runtime service implementation detail.

## Decision

Keep image policy and publication orchestration under `infra/modal`, but isolate
the provider SDK at the service boundary:

- `infra/modal/images/forge-node-base.ts` and `forge-web-test.ts` export
  provider-neutral, validated image recipes. They do not import `modal` or
  expose Modal types.
- `infra/modal/publish.ts` validates CLI input, obtains the immutable source
  revision, asks the sandbox-service provider facade to build/publish the
  recipes, and atomically writes `infra/modal/images.lock.json` only after both
  images publish successfully.
- `services/sandbox-service/src/provider/modal.ts` is created during WS-2 as the
  only Modal SDK import site. It owns both image-publication calls and, when
  WS-4 lands, runtime sandbox calls. Its public image-publishing interface uses
  project-owned data types only.
- WS-2 may add the minimal sandbox-service package/export/TypeScript scaffolding
  required to expose that facade. WS-4 extends the same package and module; it
  must not create a second Modal import site.

This is a sequencing and file-contract clarification, not an exception to the
master constraint.

## Consequences

- Semgrep can enforce one Modal import site from the first provider-backed task.
- Image recipes stay deterministic and unit-testable without credentials or a
  network connection.
- The sandbox-service package appears one task earlier than originally listed,
  but WS-2 does not implement any WS-4 lifecycle or public API behavior.
- A real publish and VM capability smoke remain credential-gated. Local tests
  cannot be reported as substitutes for those checks.

## Rejected alternatives

- Import `modal` directly from `infra/modal`: violates the master plan and the
  Plan 03 architecture.
- Treat build-time SDK use as an implicit exception: weakens an enforceable
  boundary and leaves CI policy ambiguous.
- Defer all WS-2 work until WS-4: reverses the locked task order and leaves WS-3
  and WS-10 without the image smoke they require.
