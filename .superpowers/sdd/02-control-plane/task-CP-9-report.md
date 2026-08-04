# CP-9 execution report

Status: **DONE**.

## Scope and implementation

- Added public tenant-scoped run lifecycle routes: create, read, pause, resume,
  cancel, and redirect. Run creation persists a queued row, calls the injected
  `OrchestratorPort` exactly once, and uses the run id as the workflow
  idempotency key.
- Added public tenant-scoped workspace create/read/start/checkpoint/terminate/
  preview passthrough routes through `SandboxServicePort`. No raw file-system
  or command route was added.
- Added ports that fail closed when no real binding is composed, tenant-store
  persistence helpers, audit actions, request/response Zod schemas, and route
  fakes used by the CP-9 unit suite.
- Closed the carried GATE-5 harness obligation: it sends a project-create HTTP
  request to a listening control-api using the shipping Git HTTP client, crosses
  a listening real git-service composed with its real Forgejo provider, checks
  the resulting Forgejo repository over its API, and runs `git ls-remote` on
  the provider's clone URL. The test has no fake Git client or Forgejo provider.
- Added the serial GATE-5 CI step to the existing Forgejo-backed `git-isolation`
  job. The suite logs a named local skip when credentials are missing and throws
  before test collection when `CI` is set and any required credential is absent.

## Changed files

- `.github/workflows/ci.yml`
- `pnpm-lock.yaml`
- `services/control-api/package.json`
- `services/control-api/src/app.ts`
- `services/control-api/src/orchestrator/port.ts`
- `services/control-api/src/plugins/audit.ts`
- `services/control-api/src/routes/runs.ts`
- `services/control-api/src/routes/workspaces.ts`
- `services/control-api/src/sandbox/port.ts`
- `services/control-api/src/tenant/db.ts`
- `services/control-api/src/tenant/view.ts`
- `services/control-api/test/gate5/project-forgejo.test.ts`
- `services/control-api/test/integration/helpers.ts`
- `services/control-api/test/runs.test.ts`
- `services/control-api/test/support/harness.ts`
- `services/control-api/test/support/tenant-db.ts`
- `services/control-api/vitest.config.ts`
- `services/control-api/vitest.gate5.config.ts`
- `docs/plans/02-control-plane.md`
- `tasks/todo.md`
- `.superpowers/sdd/02-control-plane/task-CP-9-report.md`

## Red and mutation evidence

The prior handoff recorded the original route-test red cases before implementation:
run creation and lifecycle routes initially returned `404 route_not_found`, and
the workspace create route initially returned `404 route_not_found`.

Fresh mutation check (2026-08-04): changed the redirect audit mapping from
`run.redirected` to `run.redirectd`, then ran:

```text
pnpm --filter @zapp/control-api exec vitest run test/runs.test.ts
Test Files  1 failed (1)
Tests  1 failed | 8 passed (9)
```

The failing assertion required `action: "run.redirected"` and received
`"run.redirectd"`. The mapping was restored and the same focused suite was
re-run green.

## Verification evidence

```text
pnpm --filter @zapp/control-api exec vitest run test/runs.test.ts
Test Files  1 passed (1)
Tests  9 passed (9)
```

```text
pnpm --filter @zapp/control-api run test:gate5
Test Files  1 passed (1)
Tests  1 passed (1)
```

That GATE-5 test completed against the available real database and Forgejo in
7.43 seconds, including the Forgejo API check and `git ls-remote` clone-path
proof.

```text
pnpm --filter @zapp/control-api test
Test Files  17 passed (17)
Tests  345 passed (345)
```

```text
pnpm --filter @zapp/control-api lint
> eslint .

pnpm --filter @zapp/control-api typecheck
> tsc --noEmit

pnpm --filter @zapp/control-api build
> rm -rf dist && tsc -p tsconfig.build.json
```

All three static/build commands exited 0. `git diff --check` also exited 0.

## Credential-gate evidence and skips

An isolated no-credential invocation of the GATE-5 config exited 0 with the
required loud named skip:

```text
[@zapp/control-api] GATE-5 SKIPPED — not run, not passed: DATABASE_URL,
FORGEJO_URL, FORGEJO_ADMIN_TOKEN, SERVICE_TOKEN_SECRET are unset
Tests  1 skipped (1)
```

The same no-credential config under `CI=1` exited 1 before collection:

```text
Error: refusing to skip GATE-5: CI is set but DATABASE_URL, FORGEJO_URL,
FORGEJO_ADMIN_TOKEN, SERVICE_TOKEN_SECRET are unset. The control-api ->
git-service -> Forgejo join would be unverified.
```

The relevant integration commands were executed, but this shell lacks database,
Redis, and Stytch integration credentials:

```text
pnpm --filter @zapp/control-api run test:integration
Test Files  1 passed | 7 skipped (8)
Tests  1 passed | 127 skipped (128)

pnpm --filter @zapp/control-api run test:isolation
Test Files  1 passed (1)
Tests  1 passed | 45 skipped (46)
```

Named reasons emitted by the harness: `DATABASE_URL` and `REDIS_URL` are unset;
the auth integration test additionally reports `STYTCH_PROJECT_ID` and
`STYTCH_SECRET` unset. These suites are unverified locally, not passed.

## Review concerns

- GATE-5 itself passed serially. A second, deliberately concurrent local
  invocation collided on its fixed test-database organization slug; CI invokes
  it once, serially, so this does not affect the required job. Do not run two
  GATE-5 processes concurrently against the same test database.
- The environment-gated database/Redis/Stytch integration and tenant-isolation
  coverage is unverified in this shell for the named missing credentials.

## Commit

Parent before this task: `0f032f28e082a28ff349227eabf8f648892c469f`.

Task commit: `feat(control-api): run lifecycle + workspace routes behind ports`
with the resulting commit hash supplied in the completion handoff. (A Git commit
cannot contain its own final hash without changing that hash.)
