# ADR-0011: Agent-tool restart and atomic workspace writes

- Status: Accepted
- Date: 2026-08-06
- Owners: Workspace runtime / agent runtime
- Approval: product-owner delegated controller decision, 2026-08-06
- Affects: WS-1, AR-4
- References: PRD §16.1–§16.3, Plan 03 WS-1, Plan 04 AR-4

## Context

AR-4 originally represented `restart_dev_server` by starting another process and
applied a validated multi-file patch through separate `writeFile` calls. The first
behavior was not a restart, and the second could leave an earlier file changed if a
later write failed. Agent-tools may not use host processes or host filesystem calls
to repair either behavior because workspace lifecycle and files belong to
`WorkspaceRuntime`.

## Decision

Extend WS-1 with exactly two workspace-owned primitives:

- `restartDevServer(contract)` stops and waits for the currently managed development
  server before starting its replacement. Readiness requires evidence that the
  contracted listener belongs to the replacement process or supervised process group;
  an unrelated listener on the same port is not readiness.
- `writeFilesAtomically(files)` validates the complete workspace-relative path set,
  resolves every target before staging, rejects leaf-symlink targets, duplicate
  canonical targets, observable same-inode aliases, and initially absent names that
  the canonical parent filesystem treats as case-folding or Unicode-normalization
  aliases. Absent-name detection uses exact-basename exclusive reservations in a
  hidden per-parent probe directory, creates none of the requested target paths, and
  removes every probe before staging. The operation stages all bytes before changing
  targets and rolls back committed targets if a later commit fails. Staging and
  rollback preserve each existing target's file mode.

Both primitives preserve `resolveInRoot` lexical and symlink checks. The batch API
accepts only `{ path, data }` records and the restart API accepts only the validated
`ExecutionContract`; neither exposes host paths, shell fragments, or process-control
options to agent-tools.

## Consequences

- `restart_dev_server` can report a replacement PID only after the prior managed
  process has stopped and the replacement owns the contract port.
- Unified patches cross the runtime boundary as one staged batch, preventing an
  agent-tools loop from creating partial writes. Multiple patch sections cannot claim
  success while collapsing onto one target because duplicate target identity rejects
  before the first staging write. An existing leaf symlink cannot be replaced while
  its former referent remains separately mutated or unchanged under a false success.
- Runtime fault-injection tests fail after the first, middle, and final real rename,
  then verify byte and mode restoration, temporary-file cleanup, and distinct truthful
  rollback or cleanup failure codes.
- Runtime implementations must provide equivalent lifecycle and batch rollback
  semantics before claiming complete WS-1 support.
- These two narrow additions are included in the AR-4 review-fix commit under the
  product-owner delegated approval recorded on 2026-08-06.
