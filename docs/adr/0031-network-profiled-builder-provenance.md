# ADR-0031: Permit contained Builder tools after untrusted workspace output

- Status: Accepted
- Date: 2026-08-12
- Approval: user directive to make the local Prompt → preview flow runnable end to end
- Affects: AR-5 policy context, AR-6 session composition, local M1 Builder runtime
- References: ADR-0016, ADR-0017, plan 03 WS-11, plan 04 AR-5/AR-6

## Context

AR-6 durably appended every tool output to one session-wide untrusted-provenance set.
AR-5 then denied every consequential tool once that set was non-empty. A Builder could
inspect a repository or perform one write, but every subsequent write, dependency install,
check, or development-server start was rejected. The M1 Prompt → preview acceptance flow
therefore could not exist, and the same behavior prevented any ordinary multi-tool Builder
session.

ADR-0016 makes the network-profiled gVisor sandbox, tool allowlist, scoped credentials, and
approval gates the containment boundary. It also names coarse provenance gating as a rule
to tune if it blocks normal work. The session must not claim that an in-process or local
runtime has that containment.

## Decision

Add a strict, code-owned execution boundary to the policy context:
`uncontained | network_profiled_sandbox`. It defaults to `uncontained`, preserving every
existing caller's fail-closed behavior.

Only the M1 composition may select `network_profiled_sandbox`, and only after its
`WorkspaceRuntime` identifies as the cloud sandbox client. Under that boundary, untrusted
provenance may feed an explicit allowlist of sandbox-contained workspace, command, check,
and local Git tools. Ask mode, the catastrophic-command signals, schemas, and the runtime
tool allowlist still apply.

External or authority-bearing operations remain denied under untrusted provenance:
database migrations, environment variables, browser/deployment adapters, previews,
releases, deploys, health checks, and rollbacks. M1 binds those ports to typed unavailable
adapters as an additional structural control.

## Consequences

The Builder can inspect, edit, install, test, start a healthy development server, and make
follow-up edits in one durable session. A local or otherwise uncontained runtime cannot opt
into the exception accidentally. New tool names are denied by default until the explicit
contained allowlist and its tests are intentionally updated.

This decision relies on ADR-0016's load-bearing rule: model-generated execution must remain
behind the provider-enforced network-profiled sandbox. Any production path that marks a
non-sandbox runtime as contained is a structural security defect.
