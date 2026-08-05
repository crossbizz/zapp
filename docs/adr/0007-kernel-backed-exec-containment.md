# ADR-0007: Kernel-backed workspace exec containment

- Status: Accepted — controller decision 2026-08-04
- Date: 2026-08-04
- Owners: Workspace runtime / sandbox security / infrastructure

## Context

WS-1 requires a timed-out command to be killed, and WS-3 owns timeout,
disconnect, explicit-kill, shutdown, and resource-accounting behavior for every
command it starts. The current workspace-agent starts each command in a process
group and sends `SIGKILL` to that group.

That boundary is incomplete. A command can call `setsid()` (or spawn a detached
child), leave the original process group, survive timeout or shutdown, continue
writing files, and disappear from the agent's metrics. A second review probe
showed the inverse lifetime bug: a process that had already exited remained in
the ownership map while output delivery was backpressured, so a reused PID or
process-group id could be killed and a successful exit could be rewritten.

PID polling cannot close these races. Descendants can fork and exit between
polls, become reparented, clear identifying environment variables, or reuse a
PID. Correct cleanup needs a kernel-owned execution boundary with an
authoritative empty-state signal.

The locked WS-2 plan currently creates ordinary Modal Sandboxes and does not
guarantee a delegated writable cgroup hierarchy or a per-exec PID namespace.
Modal's standard JavaScript Sandbox parameters expose no such guarantee. Modal
documents cgroup support for its VM Sandbox runtime, but that runtime is Beta
and is selected through experimental options. Selecting it changes deployment,
cost, and validation assumptions and therefore requires an explicit decision.

## Proposed decision

Run P0 cloud workspaces on Modal VM Sandboxes and require cgroup v2 containment
for every workspace-agent exec.

- WS-2 will create cloud sandboxes with Modal's VM runtime experimental option
  using the pinned JavaScript SDK. The image smoke test must prove that the
  workspace-agent can create and remove a delegated cgroup v2 subtree, use
  `cgroup.kill`, and observe `cgroup.events` reach `populated 0`.
- WS-3 will add a narrow native exec launcher. The agent creates one cgroup per
  execution; the launcher joins that cgroup and verifies membership before it
  executes the requested command. Buffered and PTY commands both launch through
  this path, so children inherit the boundary before user code can fork or call
  `setsid()`.
- Timeout, disconnect, explicit kill, and shutdown write to `cgroup.kill`, wait
  for the authoritative empty-state signal, and only then remove ownership and
  the cgroup directory. Output delivery has a separate lifetime and cannot keep
  an exited execution killable.
- Production cloud mode fails closed with a stable unavailable response if the
  VM runtime or cgroup delegation is absent. It must never silently downgrade to
  process-group killing or PID polling.
- macOS unit tests use an injected containment test double. A real Modal dev
  smoke test is mandatory and exercises buffered and PTY commands whose
  detached `setsid()` children try to write after timeout, disconnect, explicit
  kill, and agent shutdown. The same test verifies that PID reuse cannot change
  an already completed result.
- WS-4 provider creation, WS-2 image publishing, and WS-14 nightly E2E will all
  assert the selected runtime and containment capability. A P0 release cannot
  proceed while those checks are skipped or red.

This keeps Modal as the locked sandbox vendor. It changes only the Modal runtime
mode and the internal workspace-agent implementation; the public
`WorkspaceRuntime` and HTTP contracts remain unchanged.

## Acceptance gate

Approval authorizes implementation, not an assumption that the Beta runtime has
the required delegation. Before WS-3 can be checked complete, a real dev
sandbox must prove:

1. the pinned JavaScript SDK can request the VM runtime;
2. the baked agent can create a per-exec cgroup and place the launcher in it
   before user code starts;
3. `cgroup.kill` reaps detached descendants for buffered and PTY executions;
4. `cgroup.events` provides the empty-state signal used for ownership removal;
5. volumes, filesystem snapshots, tunnels, and readiness probes required by P0
   still work in the selected runtime.

If any item fails, WS-3 remains blocked and a superseding ADR must choose a
different kernel-backed boundary. Process-group fallback is not an accepted P0
result.

## Consequences

- Cloud workspace execution gains a kernel-authoritative ownership and cleanup
  boundary. Detached descendants cannot escape timeout, shutdown, metrics, or
  cost attribution.
- Modal VM Sandboxes are Beta. The project accepts additional provider-churn
  risk and must pin the SDK/runtime option and keep the real dev smoke test plus
  nightly E2E as release gates.
- VM Sandbox resource and feature behavior differs from the standard runtime.
  WS-2, WS-4, WS-7, WS-9, and WS-14 must verify the P0 features they consume;
  unsupported reload or memory-snapshot features may not be introduced as
  hidden dependencies.
- WS-3 gains a small native launcher and Linux-specific cgroup implementation.
  The launcher can share build and audit infrastructure with ADR-0006's proposed
  descriptor-relative helper, but acceptance of either ADR does not silently
  imply acceptance of the other.
- Local macOS tests cannot prove Linux kernel containment. They prove orchestration
  against a test double; the Modal dev test provides the security evidence.
- WS-3 remains unchecked until this ADR and ADR-0006 are accepted and both sets
  of blocker tests are green.

## Rejected alternatives

- Keep process-group killing: `setsid()` escapes it, as the committed RED probe
  demonstrates.
- Poll `/proc`, parent PIDs, process groups, or marker environment variables:
  polling has fork/exit/reparent/PID-reuse races and identifiers can be cleared
  or reused.
- Kill the entire Modal Sandbox for every command timeout: it destroys unrelated
  dev servers and concurrent agent work and violates the workspace runtime
  contract.
- Assume ordinary gVisor sandboxes expose writable delegated cgroups: the
  documented JavaScript creation contract makes no such guarantee.
- Use Modal's own remote `Sandbox.exec` for every tool command: WS-3 is the
  in-sandbox authenticated runtime boundary and must also supervise PTYs,
  streaming, local files, git, metrics, and dev-server children. Moving only
  exec out of it would split ownership and bypass the locked API architecture.
- Ship a PID-namespace or privileged supervisor without validating provider
  support: it has the same deployment-assumption problem and needs its own
  superseding ADR if VM cgroups are unavailable.
