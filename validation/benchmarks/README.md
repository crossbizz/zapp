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
