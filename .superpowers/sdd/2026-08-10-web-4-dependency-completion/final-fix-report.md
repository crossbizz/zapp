# WEB-4 dependency completion final fix report

Date: 2026-08-11

Base: `8ae1418`

Commit target: `fix(web): close WEB-4 final acceptance gaps`

## Result

The final acceptance findings are implemented across CP-21, INT-1, INT-2, and WEB-4.

- Dashboard preview state now comes from the persisted sandbox lifecycle event type. Consumed payloads use the same strict producer schemas, and an absent event returns `{ status: 'not_started', occurredAt: null }`.
- A failed GitHub import can be retried with its original operation key. PostgreSQL owns replay/rearm semantics, selects mirror or scan from persisted mirror output, and rearms one transactional outbox delivery under the project row lock.
- The import queue port now includes visibility extension. The SQS adapter uses `ChangeMessageVisibility`, and each active delivery owns a bounded heartbeat until completion, failure, or shutdown drain.
- GitHub authorize-start now requires the standard patterned `Idempotency-Key`; generic request idempotency supplies malformed, conflict, concurrent, and replay behavior.
- Dashboard project/release IDs and GitHub branch SHAs now use their semantic schemas at API, provider, and database boundaries.
- OpenAPI and the generated SDK were regenerated. The INT-1 six-variable skip record and WEB-4 17/17 project record were corrected without adding tracker entries.

## Test-first evidence

### Finding 1: preview projection and producer contract

RED:

```text
pnpm --filter @zapp/control-api test -- project-summaries.test.ts github-install.test.ts
Test Files 2 failed
Tests 6 failed | 12 passed
```

The failures showed nullable absent preview data, ignored real lifecycle payloads, unrestricted dashboard IDs, and an accepted malformed branch SHA.

GREEN:

```text
pnpm --filter @zapp/control-api test -- project-summaries.test.ts github-install.test.ts
Test Files 2 passed
Tests 18 passed

pnpm --filter @zapp/contracts test -- events.test.ts
Test Files 1 passed
Tests 19 passed

pnpm --filter @zapp/sandbox-service test -- events.test.ts
Test Files 1 passed
Tests 1 passed
```

The first producer-consumer rerun failed because `@zapp/contracts` still had its prior `dist`; rebuilding contracts exposed an old sandbox fixture whose `preview.ready` payload lacked `port` and `supervisorId`. The fixture was corrected to the real producer shape, then the suites passed.

### Finding 2: durable failed-import retry

RED:

```text
pnpm --filter @zapp/control-api test -- github-import.test.ts
Test Files 1 failed
Tests 3 failed | 13 passed
```

The generic Redis layer returned the original replay response and the failed row was not rearmed.

The PostgreSQL test command was:

```text
node --env-file-if-exists=../../.env ./node_modules/vitest/vitest.mjs run --dir test/integration --no-file-parallelism github-import-retry.test.ts
```

Two fixture-setup attempts failed before behavioral execution because the PostgreSQL template received JSON and then `Date` values through unsupported interpolation. After using supported serialized/timestamp inputs, the behavioral RED failed on the generic replay header, as expected.

GREEN:

```text
pnpm --filter @zapp/control-api test -- github-import.test.ts
Test Files 1 passed
Tests 16 passed

node --env-file-if-exists=../../.env ./node_modules/vitest/vitest.mjs run --dir test/integration --no-file-parallelism github-import-retry.test.ts
Test Files 1 passed
Tests 1 passed
```

The PostgreSQL test covers API acceptance, polling, concurrent same-key retry, mirror-stage and scan-stage selection, transactional outbox state, publisher delivery, and publish-once behavior. Existing unit coverage retains distinct-key conflict behavior.

### Finding 3: scan visibility lease

RED:

```text
pnpm --filter @zapp/control-api test -- github-import-queue.test.ts
Test Files 1 failed
Tests 4 failed | 6 passed
```

The queue had no visibility-extension capability, no heartbeat during blocked work, and no SQS `ChangeMessageVisibility` command.

GREEN:

```text
pnpm --filter @zapp/control-api test -- github-import-queue.test.ts
Test Files 1 passed
Tests 10 passed
```

Deterministic manual-timer tests cover work beyond one visibility window, competing receive/DLQ exclusion, heartbeat failure and redelivery, worker-error cleanup, SQS bounds, and shutdown drain with the lease still active.

### Finding 4: authorize-start idempotency

RED:

```text
pnpm --filter @zapp/control-api test -- github-install.test.ts
Test Files 1 failed
Tests 2 failed | 16 passed

pnpm --filter @zapp/control-api test -- openapi-contract.test.ts -t "authorize idempotency"
Test Files 1 failed
Tests 1 failed
```

Missing and empty keys were accepted, and OpenAPI had no required authorize header. The established plugin already supplied exact replay and concurrent conflict behavior once the route declared the header.

GREEN:

```text
pnpm --filter @zapp/control-api test -- github-install.test.ts
Test Files 1 passed
Tests 18 passed

pnpm --filter @zapp/control-api test -- openapi-contract.test.ts -t "authorize idempotency"
Test Files 1 passed
```

Coverage pins missing, empty, short, invalid-character, overlong, concurrent, and exact replay cases. WEB-4 passes one stable UUID per authorize action.

### Finding 5: semantic schemas and generated artifacts

RED:

The first preview/schema command above rejected the new expected project/release prefixes and malformed commit SHA only after implementation. The stale artifact proof was:

```text
pnpm --filter @zapp/control-api test -- openapi-contract.test.ts -t "match deterministic"
Test Files 1 failed
```

GREEN:

```text
pnpm --filter @zapp/api-client generate
OpenAPI contract tests 10 passed

pnpm --filter @zapp/api-client test
Test Files 1 passed
Tests 52 passed
```

The generator retained its existing recursive-reference warnings; no generated operation wrapper changed.

### Finding 6: execution evidence

Corrected:

- Plan 06 INT-1 live skip evidence now names `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_LIVE_CALLBACK_CODE`, and `GITHUB_LIVE_INSTALLATION_ID`.
- Plan 08 WEB-4 project E2E evidence now reads 17/17.
- The implementation plan has one dated whole-branch correction note. No tracker entry was added or duplicated.

## Consolidated focused verification

```text
pnpm --filter @zapp/control-api test -- project-summaries.test.ts github-install.test.ts github-import.test.ts github-import-queue.test.ts openapi.test.ts openapi-contract.test.ts server-entrypoint.test.ts
Test Files 7 passed
Tests 65 passed

pnpm --filter @zapp/api-client test
Test Files 1 passed
Tests 52 passed

pnpm --filter @zapp/web test -- projects.spec.ts
17 passed

node --env-file-if-exists=../../.env ./node_modules/vitest/vitest.mjs run --dir test/integration --no-file-parallelism github-import-retry.test.ts
Test Files 1 passed
Tests 1 passed

node --env-file-if-exists=../../.env ./node_modules/vitest/vitest.mjs run --dir test/integration --no-file-parallelism tenant-isolation
Test Files 1 passed
Tests 54 passed

pnpm --filter @zapp/control-api run test:gate5
Test Files 1 passed
Tests 1 passed
```

The first full WEB-4 project run failed 15/17 because two existing mocks still returned `preview: null`; the second affected case then timed out after response validation failed. The mocks were changed to the explicit `not_started` contract. The two focused cases passed 2/2, the full project file passed 17/17, and the authorize-wrapper assertion then passed its focused import case 1/1.

## Package checks

Touched package lint, typecheck, and build passed for contracts, API client, control API, sandbox service, and web.

Genuine reruns retained:

- Control API lint first reported four lease/OpenAPI style errors. They were fixed, then lint passed.
- Sandbox and control API typecheck first found narrow test-fake types. WEB typecheck first read stale generated API client output, then exposed the now-required authorize header. The fakes and wrapper were corrected, API client was rebuilt, and all touched typechecks passed.
- A parallel control API build ran while sandbox service removed its own `dist`, so the control build could not resolve that package. The sequential control build passed.
- Next build passed with its existing multiple-lockfile workspace-root warning.

## Root gates and honest failures

```text
pnpm lint
Architecture tests 184 passed
Turbo tasks 40 successful / 40

pnpm typecheck
Turbo tasks 44 successful / 44
```

The required one-time cold gate was run once:

```text
pnpm verify:cold
Turbo tasks 84 successful / 90
exit 1
```

The clean build completed, WEB passed 84/84, and control API passed 559/559. Six unrelated tests failed under the full parallel CPU/process load:

1. Modal package exports: one 5-second timeout.
2. Git mirror: five 5-second timeouts, including one cleanup `ENOTEMPTY` after timeout.
3. Sandbox git clone: one 15-second timeout.
4. Preview proxy: one 15-second cleanup-hook timeout.
5. Temporal task isolation: one 30-second timeout with late worker/temporary-git cleanup errors.
6. Workspace-agent circuit test: observed `restarting` rather than `failed` before its polling deadline.

Each failing target then passed in isolation:

```text
Modal package exports: 1/1, 183ms
Git import mirror: 10/10, 7.87s total
Sandbox git clone: 3 passed / 1 credential-gated skip, 3.40s total
Preview-proxy target: 1/1, 2.99s
Workspace-agent target: 1/1, 1.64s
Temporal task-isolation target: 1/1, 4.66s
```

A cached `pnpm verify` follow-up was also run. It passed 88/90 tasks but still exceeded existing timeouts in two git-mirror cases and the preview-proxy cleanup hook, so it exited 1. All other previously failing package suites passed in that run, including orchestrator worker 204/204 and workspace agent 114/114. This result is not represented as green.

The serial integration follow-up without environment loading failed closed when PostgreSQL suites could not see `DATABASE_URL`. Repeating it through Node's root `.env` loader reached the database suite but found the reused dev database ahead of this branch: a later non-null `usage_ledger.operation_key` exists, while this branch's legacy DB identity fixtures do not supply it. Four DB identity tests failed and the serial DAG stopped. The shared database was not reset and unrelated migrations/tests were not changed. The change-owned PostgreSQL test, tenant isolation, and Gate 5 all passed against the same configured database.

## Skips

Real GitHub provider checks were deliberately not rerun, per the final-review instruction and the prior one-time gate record.

- INT-1 gate inputs: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_LIVE_CALLBACK_CODE`, `GITHUB_LIVE_INSTALLATION_ID`.
- INT-2 gate inputs: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_LIVE_INSTALLATION_ID`, `GITHUB_LIVE_REPOSITORY`, `GITHUB_LIVE_BRANCH`.

The cold package run also retained existing provider/environment gates:

- Eight Modal cases skipped without `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`.
- One PostgreSQL workspace-state case skipped without an inherited `DATABASE_URL`.
- One live git-service/Forgejo clone case skipped without inherited `GIT_SERVICE_URL`, `SERVICE_TOKEN_SECRET`, and `DATABASE_URL`.

No real GitHub provider command was invoked during this fix wave.

## Files changed

Contracts and artifacts:

- `packages/contracts/src/events.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/events.test.ts`
- `packages/api-client/openapi.json`
- `packages/api-client/src/generated.ts`

Control API:

- `services/control-api/src/integrations/github/app.ts`
- `services/control-api/src/integrations/github/import-queue.ts`
- `services/control-api/src/integrations/github/import.ts`
- `services/control-api/src/integrations/github/install.ts`
- `services/control-api/src/integrations/github/schemas.ts`
- `services/control-api/src/tenant/db.ts`
- `services/control-api/src/tenant/view.ts`
- `services/control-api/test/github-import-queue.test.ts`
- `services/control-api/test/github-import.test.ts`
- `services/control-api/test/github-install.test.ts`
- `services/control-api/test/integration/github-import-retry.test.ts`
- `services/control-api/test/openapi-contract.test.ts`
- `services/control-api/test/project-summaries.test.ts`
- `services/control-api/test/server-entrypoint.test.ts`
- `services/control-api/test/support/tenant-db.ts`

Producer and browser:

- `services/sandbox-service/src/routes/workspaces.ts`
- `services/sandbox-service/test/events.test.ts`
- `apps/web/src/components/projects/ProjectCard.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/e2e/projects.spec.ts`

Evidence:

- `docs/plans/06-git-and-integrations.md`
- `docs/plans/08-web-ux.md`
- `docs/superpowers/plans/2026-08-10-web-4-dependency-completion.md`
- `.superpowers/sdd/2026-08-10-web-4-dependency-completion/final-fix-report.md`

## Self-review

- The import retry bypasses only the generic response cache for this route; the public header remains required and parsed, and PostgreSQL owns the durable identity.
- The project row lock serializes same-project retry acceptance. The transaction clears failure and rearms one stage-specific outbox key; publisher locking preserves one publish.
- Visibility extension is a required queue capability, not a worker heuristic. Heartbeat failure suppresses deletion so ordinary SQS redelivery remains available. Shutdown waits for active work while its heartbeat remains alive, then clears all timers.
- Preview state uses the exact event discriminator. Malformed lifecycle payloads are excluded at the SQL/in-memory boundary instead of inferred in the browser.
- No new route, table, column, migration, vendor, secret, or UI-private data path was added.
- Generated OpenAPI and TypeScript output match the live document. No tracked build output was added.
- `git diff --check` passed before final staging. No tracker entry was duplicated.

## Concerns

- The standard cold and cached root verify commands remain red because existing load-sensitive tests exceed fixed timeouts under monorepo parallelism. Their isolated reruns pass, but the failed root results are retained above.
- The shared dev database contains a later `usage_ledger.operation_key` constraint than this branch's migration/test fixtures. This blocks the full serial DB integration DAG in this worktree without resetting shared state or changing unrelated historical code.
- Existing OpenAPI recursive-reference warnings and Next's multiple-lockfile root warning remain unchanged.
