# ADR-0024 — Resolve workspace secrets at app-command launch

**Status:** Accepted (controller-delegated execution, 2026-08-09)

## Context

Plan 03 originally required WS-11 to decrypt project/environment secrets "on workspace
create" while also requiring their values to exist only in the application process.
Those requirements cannot both be true in the locked runtime:

- workspace creation has no environment or secret references;
- the long-lived workspace-agent starts before an application command exists; and
- placing values in Modal's sandbox `env` would expose them to the agent process.

The locked workspace-agent already has the required structural boundary: every regular
`/exec` request accepts a strict child-only environment and constructs the child process
environment without mutating the agent daemon environment. Rebuilding the immutable image
to add a second secret registry would add no containment value.

## Decision

WS-11 resolves secrets at the service-authenticated app-command launch boundary instead of
workspace creation. The internal exec request carries only tenant-scoped secret references
(`environmentId` plus secret IDs), never values and never caller-selected raw environment
entries. Sandbox-service:

1. resolves the workspace through the required organization/project scope;
2. calls CP-7 separately for each referenced secret and validates returned tenant, project,
   environment, name, and ID metadata;
3. passes the resolved values plus `ZAPP_SECRET_NAMES` only in the workspace-agent exec
   request's child environment;
4. redacts buffered and streaming stdout/stderr before writing any response bytes; and
5. fails closed when the decrypt boundary is unavailable.

The agent daemon and Modal sandbox creation environment contain no secret values. Raw `env`
is removed from the service exec route even though it remains a private provider primitive.
Non-secret contract variables require a future typed execution-contract field; WS-11 does
not invent an untrusted name list.

Network policy remains defense in depth as required by PRD §18.11. The pinned Modal V2 SDK
has no enforceable per-sandbox egress-policy primitive, so the create boundary resolves and
records the complete requested policy structurally before provider allocation, including
whether provider enforcement was available. The three strict profiles remain executable
policy data; no heuristic network filter is claimed as containment.

## Consequences

- Secret values exist in one application child and the authenticated RPC body needed to
  launch it, but never in the agent process environment, a config file, a workspace row, a
  log, or a response.
- A service restart loses no registry: each launch re-resolves CP-7 and reconstructs its
  redactor before the provider call.
- The route composition must receive both the scoped secret injector and a network-policy
  recorder; tests cannot accidentally build an unsecured application boundary.
- Managed dev-server secret injection remains out of P0 until its public execution contract
  defines environment references. Regular app-command execution is the M1 load-bearing path.
