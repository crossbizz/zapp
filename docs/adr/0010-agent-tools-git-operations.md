# ADR-0010: Typed agent-tool merge and revert operations

- Status: Accepted
- Date: 2026-08-06
- Owners: Workspace runtime / agent runtime
- Approval: product-owner delegated controller decision, 2026-08-06
- Affects: WS-1, AR-4
- References: PRD §16.1–§16.3, Plan 03 WS-1, Plan 04 AR-4

## Context

AR-4 must implement the `merge_branch` and `revert_commit` tools while routing every
Git action through `WorkspaceRuntime.git`. The WS-1 operation vocabulary exposed
status, diff, log, show, add/commit, push, checkout, branch, and restore, but it did
not expose merge or revert. Agent-tools therefore could not implement those two P0
tools truthfully without bypassing the runtime or mapping them to different Git
semantics.

## Decision

Extend `GitOperation` and `GitOp` with exactly two operation-specific variants:

- `{ operation: "merge", ref: string }`
- `{ operation: "revert", commit: string }`

`WorkspaceRuntime.git` validates merge refs using Git-compatible ref safety rules
and accepts only hexadecimal commit IDs for revert. It supplies the noninteractive
safe flags itself. Callers cannot provide arbitrary flags or command strings for
either operation, and agent-tools invokes no host Git process.

Focused runtime tests exercise legitimate merge and revert effects in a real
temporary repository and reject option injection, traversal-shaped refs, revision
expressions, reflog expressions, symbolic names, and shell-shaped commit values.

Rejected alternatives:

- Run `git` through `WorkspaceRuntime.exec` from agent-tools: this bypasses the
  dedicated Git allowlist and creates a generic command escape hatch.
- Approximate merge or revert through checkout, restore, or patch application: those
  operations do not preserve the requested Git semantics.
- Add generic merge/revert argument arrays: model-supplied flags would unnecessarily
  expand the attack surface.

## Consequences

- Every AR-4 Git tool remains inside the WS-1 safety boundary.
- Merge is limited to one validated ref and revert to one validated commit per call;
  broader strategies require a future reviewed contract change.
- Existing runtime implementations must handle the two new discriminated-union
  variants before claiming complete `WorkspaceRuntime` support.
- The AR-4 commit includes the interface extension, focused tests, this ADR, and the
  matching plan paper trail under the approved deviation.
