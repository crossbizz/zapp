# M6 benchmark suite

This catalog is the fixed ten-app validation corpus from PRD sections 40.2 and
40.3. It reuses checked-in verification fixtures so every benchmark has a
runnable seed, source evidence, five repeat-change prompts, and the required
defect, shared-component, schema, dependency, rollback, and production-failure
scenarios.

Validate the catalog before a run:

```sh
pnpm validation:benchmarks
```

Create an isolated working copy under an existing parent directory:

```sh
node validation/benchmarks/materialize.mjs react-vite-crud /tmp/zapp-v1-crud
```

The materializer refuses to overwrite a destination or copy into its source.
Seeds containing committed environment files or symbolic links are rejected.
Provider credentials stay in the runner's untracked environment; they are not
part of the catalog or materialized fixtures.

V-1 only defines and validates the corpus. V-2 owns execution of all fifty
repeat changes and their recorded results after the required platform
milestones are integrated.

## V-2 public API preflight

V-2 uses only the public versioned API. Before any paid or mutating operation,
provide an operator-issued session and explicit tenant selection, then run:

```sh
ZAPP_BENCHMARK_API_BASE_URL=https://api.example.test \
ZAPP_BENCHMARK_BEARER_TOKEN=... \
ZAPP_BENCHMARK_ORGANIZATION_ID=org_... \
node validation/benchmarks/repeat-change.mjs
```

The preflight calls `GET /v1/me` with the bearer credential and
`x-organization-id`, and refuses to start if the identity lacks an active
membership. It never creates result evidence: a preflight is not a benchmark
execution. The result validator recomputes the checked-in manifest's byte
SHA-256 and accepts only exact one-to-one coverage of its 10 app IDs and five
indexed feature changes. Every execution prompt must equal its mapped manifest
feature change. Every referenced evidence file resolves inside this repository
to a regular file and has its raw-byte SHA-256 verified. Each passed artifact
also needs one passed, hash-verified rollback result for every app. Unknown
evidence fields, duplicate mappings/run IDs, partial evidence, and contradictory
timing cannot be reported as successful.
