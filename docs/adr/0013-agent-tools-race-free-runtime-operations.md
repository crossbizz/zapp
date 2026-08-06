# ADR-0013: Race-free agent-tool runtime operations

- Status: Accepted
- Date: 2026-08-06
- Owners: Workspace runtime / agent runtime
- Approval: product-owner delegated controller decision, 2026-08-06
- Affects: WS-1, AR-4
- References: ADR-0006, ADR-0011, PRD §16.1–§16.3

## Context

Agent-tools previously validated a search or deletion target with one runtime call and
used it with another. A concurrent workspace process could replace the checked path
between calls. Rename was assembled from read, write, and recursive delete, so a
self-rename could destroy its source. Dev-server readiness also accepted any listener
on the requested port, including an unrelated process.

These operations cannot be made safe by adding another model-facing precheck. Path
identity and process ownership belong to the runtime that performs the operation.

## Decision

Extend WS-1 with three narrow typed operations:

- `search({ pattern, path, glob?, fixedStrings?, ignoreCase? })` runs ripgrep against
  a runtime-confined target and returns the normal structured execution result;
- `deleteFile(path)` performs a nonrecursive unlink, so a directory or a path swapped
  to a directory is rejected rather than recursively removed; `ENOENT` is an
  already-complete success so the operation matches its idempotent tool metadata;
- `renameFile({ source, destination, overwrite: "replace" })` provides atomic replace
  semantics, rejects normalized, canonical parent-symlink, and observable same-inode
  aliases before mutation, and accepts no arbitrary rename flags.

Agent-tools makes exactly one runtime call for each operation. Cloud and production
runtime adapters must implement all three through ADR-0006's descriptor-relative
helper, binding validation and use to pinned in-workspace descriptors. The local
memory test double uses the host's typed primitives for development coverage; its
pathname checks are not the production confinement boundary.

Dev-server readiness must identify a listener owned by the spawned process or its
supervised process group. A listener on the contracted port without that ownership
evidence is not readiness.

## Consequences

- WS-3's workspace-agent protocol must expose corresponding typed operations backed
  by its descriptor-relative helper; no generic filesystem or arbitrary-ripgrep
  escape hatch is permitted.
- Search and grep retain ripgrep's exit-1 meaning of a successful zero-match result.
- File deletion no longer supplies recursive behavior to agent-tools and replay after
  an already-completed deletion remains successful. Rename overwrite and same-object
  rejection behavior are explicit and cross-runtime conformance-testable.
- Restart can wait until timeout when an unrelated listener wins the port race, but
  it cannot report that contender as the replacement server.
