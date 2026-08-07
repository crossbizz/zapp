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
`WorkspaceRuntime`. Later reviews proved two lost-update windows: patch context could
be validated before the runtime commit, and a local runtime could perform a final
byte comparison before an unconditional rename. A queue shared by runtime methods
does not close the second window because child commands, Git, editors, other runtime
instances, and provider operations need not participate in that queue. Node/POSIX
does not expose a content-conditional replacement primitive.

## Decision

Extend WS-1 with exactly two workspace-owned primitives:

- `restartDevServer(contract)` stops and waits for the currently managed development
  server before starting its replacement. Readiness requires evidence that the
  contracted listener belongs to the replacement process or supervised process group;
  an unrelated listener on the same port is not readiness. The existing
  `startDevServer(contract)` uses the identical ownership/readiness evidence, and the
  cloud provider/client maps start and restart one-for-one to distinct strict routes.
- `writeFilesAtomically(files)` validates the complete workspace-relative path set,
  resolves every target before staging, rejects leaf-symlink targets, duplicate
  canonical targets, observable same-inode aliases, and initially absent names that
  the canonical parent filesystem treats as case-folding or Unicode-normalization
  aliases. Absent-name detection uses exact-basename exclusive reservations in a
  hidden per-parent probe directory, creates none of the requested target paths, and
  removes every probe before staging. The operation stages all bytes before changing
  targets and rolls back committed targets if a later commit fails. Staging and
  rollback preserve each existing target's file mode. Guarded updates use an opaque,
  provider-owned revision: `readFileForUpdate(path)` returns `{ data, revision }`, and
  the corresponding file record carries `expectedRevision`. A runtime may return a
  revision only when its backing provider can atomically validate all expected
  revisions and commit the complete batch at one linearization point. The revision
  domain must observe every mutation path that can affect the files, including child
  commands, Git, editors, other runtime instances, and provider operations. An
  in-process queue or advisory lock is insufficient unless those paths are compelled
  to participate. A mismatch or disappearance raises a typed atomic-write conflict
  and changes no target. A runtime without that enforceable capability, including the
  Node filesystem-backed `MemoryWorkspaceRuntime`, fails guarded snapshot reads and
  guarded writes closed with the same conflict. `apply_patch` supplies the revision
  paired with the bytes used for hunk validation and maps the conflict to its existing
  `patch_conflict` result. Unguarded batches retain staging, rollback, mode, alias, and
  runtime-local serialization guarantees.

Both primitives preserve `resolveInRoot` lexical and symlink checks. The batch API
accepts only `{ path, data, expectedRevision? }` records and the restart API accepts
only the validated `ExecutionContract`; neither exposes host paths, shell fragments,
or process-control options to agent-tools.

## Consequences

- `run_dev_server` and `restart_dev_server` can report a PID only after the returned
  supervisor proves that process/group owns the contract port; restart additionally
  waits for the prior managed process to stop and reports a replacement PID.
- Unified patches cross the runtime boundary as one staged batch, preventing an
  agent-tools loop from creating partial writes. Multiple patch sections cannot claim
  success while collapsing onto one target because duplicate target identity rejects
  before the first staging write. An existing leaf symlink cannot be replaced while
  its former referent remains separately mutated or unchanged under a false success.
  Provider revisions prevent a validated patch from overwriting a source edit that
  wins before the atomic provider commit. There is no compare-to-rename interval in a
  conforming guarded implementation; runtimes that cannot provide this guarantee do
  not attempt the patch.
- Runtime fault-injection tests fail after the first, middle, and final real rename,
  then verify byte and mode restoration, temporary-file cleanup, and distinct truthful
  rollback or cleanup failure codes.
- Runtime implementations must provide equivalent lifecycle and batch rollback
  semantics before claiming complete WS-1 support. Guarded update support additionally
  requires a provider revision CAS covering every workspace mutation path; unsupported
  implementations fail closed rather than emulating CAS with compare-then-rename.
- These two narrow additions are included in the AR-4 review-fix commit under the
  product-owner delegated approval recorded on 2026-08-06.
