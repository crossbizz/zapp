# ADR-0033: Local Docker sandbox provider

## Context

The locked P0 production sandbox provider is Modal. The developer entry point
also used Modal, so a provider spend limit prevented the otherwise-local
prompt-to-preview flow from running. Docker and a digest-pinned public Forge image
are already part of the supported development environment.

A single shared writable container was considered and rejected because it would
break tenant/project isolation and concurrent branch ownership.

## Decision

`services/sandbox-service` will support a development/test-only Docker adapter
selected by `SANDBOX_PROVIDER=docker`. Local startup defaults to Docker. Production
requires `SANDBOX_PROVIDER=modal` and retains the current Modal implementation.

Docker mode uses one isolated container and dedicated bridge network per active
project branch, loopback-only published ports, a project cache volume, and the
digest-pinned public image in `infra/modal/images.lock.json`. Workspace source is
durable in internal Git, not the container or a Docker snapshot.

The control plane persists the actual selected provider. No Docker operation is
added outside sandbox-service, and no public API changes provider-specific
identity into a product identifier.

The local provider exposes its agent and preview tunnels as loopback HTTP. The
preview transport accepts unencrypted transport only for loopback hosts; every
non-loopback tunnel still requires HTTPS. Local Vite processes prefer IPv4 so
their loopback listener matches Docker's published-port health checks.

Provider propagation reaches the Temporal worker's workspace schemas and
capability evidence. Long-running session activities emit native Temporal
heartbeats as well as their awaited durable checkpoint acknowledgement; the two
channels have different liveness and durability responsibilities.

## Consequences

- Developers can exercise the real signed-in prompt-to-preview product without a
  Modal account or spend.
- Local runs retain per-project isolation and branch ownership instead of sharing
  one writable container.
- Production behavior and provider evidence remain Modal-backed.
- Docker development networking can structurally isolate a workspace or fully
  disconnect it, but cannot reproduce Modal's domain-level egress allowlist. The
  local adapter does not claim that evidence.
- The public OCI mirror becomes a required local-development artifact and stays
  digest pinned.
- Loopback HTTP is a deliberate development-only transport exception and cannot
  be widened to a remote host by configuration.
