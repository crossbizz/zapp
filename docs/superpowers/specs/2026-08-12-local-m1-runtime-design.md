# Local M1 Runtime and Live Acceptance Design

**Date:** 2026-08-12

**Status:** Approved for implementation

**Owner:** M1 cross-plan gate repair

## Problem

The M1 feature tasks are checked in `tasks/todo.md`, but the repository does not
currently provide a supported way to run their shipping implementations as one
local product. `pnpm dev` starts only packages with a `dev` script. In the current
tree that excludes a deployable sandbox-service process and the production
`agent-runs` Temporal worker. The production worker factories and activity seams
exist, but the model/session/tool/workspace/event activity graph is not composed
outside tests. The web process also does not receive the root environment by
default.

This is why passing component and fixture tests does not presently establish the
M1 browser exit criterion. The repair must close the production-composition gap;
a supervisor that merely starts the existing partial set of processes would open
a UI that cannot complete a prompt.

## Goal

Provide one fail-closed command that lets a developer run and use the real M1
walking skeleton from a browser on a Mac:

```text
Stytch sign-in
  -> prompt
  -> project and internal Forgejo repository
  -> keyed Temporal Builder run
  -> Anthropic through model-gateway
  -> Modal workspace from the locked forge-node-base image
  -> generated-app dev server
  -> authenticated preview beside chat
  -> follow-up edit
  -> internal Git commit
  -> refreshed preview
```

The zapp web app, APIs, workers, Postgres, Redis, Temporal, Forgejo, MinIO, and
LocalStack run locally. Stytch, Anthropic, and Modal remain real external
providers. No fixture API, fake model, fake sandbox, UI-private endpoint, or
direct client access to provider credentials is permitted in the live path.

## Non-goals

- Completing the remaining M2 Mission Control, interview/approval, code/log/test,
  or template-gallery UI tasks.
- Making every M3–M5 workflow locally deployable as part of this repair.
- Containerizing all TypeScript services.
- Rebuilding Modal images. The runtime consumes the immutable entries in
  `infra/modal/images.lock.json`.
- Replacing Stytch, Anthropic, Modal, Forgejo, Temporal, or any other locked
  provider.
- Turning local startup into a production deployment system.

## User commands

### `pnpm local`

The primary developer command:

1. Validates Node 22+, pnpm 9.15+, Docker, Compose, required ports, root `.env`,
   the three M1 provider credential groups, and the locked dev Modal images.
2. Runs the existing idempotent `scripts/dev-up.sh` infrastructure bootstrap and
   database migrations.
3. Builds the workspace packages needed by runtime entrypoints.
4. Starts application processes in dependency order and waits for explicit
   readiness at each boundary.
5. Opens `http://localhost:3000` after every required process is ready.
6. Prints the web, API, Temporal UI, Forgejo, and MinIO console URLs.
7. Supervises children until Ctrl-C or a required process exits.

`pnpm local --no-open` performs the same startup without opening a browser.
Re-running the command is safe. Existing Docker volumes, database rows, Git
repositories, and durable Temporal state are preserved.

### `pnpm test:m1:live`

The final provider-backed acceptance gate. It runs once after local review rounds
are complete. It uses the public API and browser UI wherever the user journey
does, records the created entity identifiers, and proves the M1 outcomes without
claiming interactive Stytch sign-in as automated when it is not. The command
must never silently downgrade to fixtures.

The gate may ask the developer to complete Stytch sign-in in the opened browser,
then continues from the authenticated session. It must report each missing
credential or unavailable provider as a failure, not a pass or hidden skip.

## Runtime architecture

### 1. Local supervisor

A Node-based supervisor owns only local process lifecycle. It reads `.env`
without printing values, supplies the required public web environment explicitly,
spawns each service in its package directory, prefixes output with the process
name, and retains a bounded per-process log tail for error summaries.

The supervisor does not create product rows, call model or Modal providers, fake
health, infer run state from prose, or own durable workflow state. Those remain
inside their existing service boundaries.

Startup is a dependency graph, not a fixed sleep:

```text
Docker infrastructure + migrations + immutable-image preflight
  -> git-service
  -> model-gateway
  -> sandbox-service
  -> agent-runs worker + verification worker
  -> control-api
  -> web
```

HTTP services use `/healthz`. Temporal workers emit one machine-readable ready
line only after connecting and registering the production queue. The web server
is ready only when `/login` responds and its configured API origin is the local
control plane.

If any required child exits, the supervisor prints the component name, exit
status, and redacted log tail, terminates the other application children, and
exits nonzero. Ctrl-C performs the same coordinated application shutdown with a
zero exit. Docker containers and volumes remain running.

### 2. Deployable sandbox-service entrypoint

Add a real sandbox-service runtime entrypoint around the existing
`composeSandboxApp` and Modal provider. It binds:

- the locked `forge-node-base` dev image from `images.lock.json`;
- Postgres-backed workspace/lifecycle/checkpoint/cost state;
- the existing durable runaway-compute governor and plan limits;
- scoped Git tokens from git-service;
- scoped secret decryption and preview-event/usage clients through control-api;
- service-token verification;
- network profiles and existing preview transport;
- startup reconciliation and bounded shutdown for monitors/reapers.

The service exposes its existing `/internal/...` API on `127.0.0.1:4400` plus an
unauthenticated shallow `/healthz`. Health means the HTTP process and required
local dependencies are ready; it does not spend provider resources by creating a
Modal workspace.

### 3. Deployable M1 run worker

Add a production `agent-runs` worker entrypoint. It composes the existing
production Temporal worker and activity idempotency interceptor with concrete
adapters for:

- durable event persistence and run-status transitions;
- workspace creation/attachment and commit/push through sandbox-service and
  git-service boundaries;
- the existing session loop;
- model streaming through model-gateway only;
- tool execution through the registered `@zapp/agent-tools` implementations,
  with workspace operations routed to sandbox-service;
- Temporal checkpoint-backed session transcripts;
- approval reads through the existing database repository;
- redaction, prompts, budgets, context assembly, and result collection from the
  existing policy/runtime packages.

The M1 local path uses the durable single-Builder workflow already proven by
AR-8. This repair makes no completion claim for M2/M3 workflows whose complete
production activity compositions do not yet exist. The local configuration
selects the M1 workflow structurally at the control-plane composition boundary;
it does not rewrite requests based on prompt text and it does not change staging
or production behavior.

Follow-up conversation messages signal the same Temporal workflow and reuse its
durable workspace/session state. Every mutation retains its existing idempotency
key.

### 4. Control plane and web

The control API remains the only browser-facing backend. The browser consumes
only generated `/v1` API operations and authenticated zapp preview URLs.
`NEXT_PUBLIC_CONTROL_API_URL=http://127.0.0.1:4000` is supplied to Next.js by the
supervisor rather than being copied into a package-local secret file.

The supervisor does not bypass Stytch. OAuth callbacks use the existing
`APP_BASE_URL=http://localhost:3000` and `API_BASE_URL=http://localhost:4000`
configuration. Modal URLs, connect tokens, model keys, Forgejo admin credentials,
and service tokens remain server-only.

## Product data flow

1. The signed-in browser posts a prompt to the public project and run APIs.
2. The control plane transaction creates tenant-scoped project records and the
   internal Forgejo repository, then starts the keyed Temporal workflow.
3. The run worker asks sandbox-service for a scoped workspace. Sandbox-service
   obtains a short-lived repo token, starts Modal from the locked image, and
   clones the repository.
4. The session loop requests completions through model-gateway. Model output can
   invoke only registry/policy-approved tools; workspace mutations cross the
   sandbox-service boundary.
5. Durable structured events are written to Postgres, fanned out through Redis,
   and reduced by the web SSE client into conversation and preview state.
6. The generated app dev server is supervised in the Modal workspace. Preview
   traffic reaches it only through zapp's authenticated, same-origin bridge.
7. The worker commits and pushes the applied change to internal Git. A follow-up
   user message continues the durable run, makes another committed edit, and the
   preview bridge displays the updated app.

## Failure handling and safety

- Preflight reports variable names and remediation only; it never prints values.
- Placeholders such as `replace-me` are treated as absent.
- Port conflicts identify the owning port and stop before starting a partial
  runtime.
- Every boundary validates request/response data with existing or new Zod
  schemas.
- Provider failures surface as named service/run failures and structured events.
- A service readiness failure stops the app process group and exits nonzero.
- A failed or incomplete live acceptance step is never reported as success.
- Startup does not delete data, rebuild images, rotate credentials, or mutate
  provider configuration.
- Cross-tenant reads retain 404 behavior. Service-token scopes remain least
  privilege.
- No direct Modal SDK call is added outside sandbox-service and no direct model
  call is added outside model-gateway.

## Testing strategy

Implementation follows TDD in small slices:

1. Supervisor unit tests first prove environment classification, startup DAG,
   readiness timeouts, log redaction, child-crash propagation, Ctrl-C shutdown,
   `--no-open`, and preservation of Docker state.
2. Sandbox composition tests first prove that the deployable entrypoint includes
   every existing route and rejects missing production bindings.
3. Worker composition tests first prove that a real local Temporal server can
   execute the M1 workflow through concrete HTTP/DB adapters and that a worker
   restart preserves the activity/transcript boundary.
4. A local-process smoke test starts the supervisor with seam providers and
   verifies all readiness contracts without spending provider resources.
5. Existing package lint, typecheck, build, unit, integration, isolation, and
   architecture gates run after the focused tests.
6. One independent review round exits with no correctness or structural-control
   finding.
7. Exactly one final real-provider gate performs prompt -> preview -> follow-up
   edit -> Git commit and records its evidence. It additionally terminates the
   active Modal sandbox and proves the project resumes from durable Git and
   control-plane state, satisfying the master plan's M1 durability criterion.
   Immutable images are consumed, not rebuilt.

## Acceptance criteria

- `pnpm local --no-open` reaches a ready state from a healthy clone with valid M1
  credentials and the existing Docker stack.
- `pnpm local` opens the real login page only after required services are ready.
- A browser user can sign in, submit an ordinary prompt, and see a generated app
  in the authenticated Preview panel beside chat.
- The first agent change and one follow-up edit each land as internal Git commits,
  and the preview reflects the follow-up.
- Terminating the active Modal sandbox during the acceptance run does not lose
  source or ordered events; a replacement workspace restores from internal Git
  and the project resumes from durable state.
- No client request or browser state contains a provider credential or raw Modal
  URL.
- Any missing dependency, provider rejection, child crash, or failed acceptance
  assertion exits nonzero with the failing component named.
- The command is documented in `docs/dev-setup.md` with start, stop, retry, URL,
  and troubleshooting instructions.

## Delivery bookkeeping

Before implementation, add an expanded M1 gate-repair task to the master plan and
`tasks/todo.md`. Its Files, Interfaces, TDD steps, verification commands, live
provider gate, acceptance criteria, and prescribed commit message are binding.
The tracker remains unchecked until the live M1 evidence exists. The task commit
includes its tracker check and execution-log entry, as required by ADR-0022.
