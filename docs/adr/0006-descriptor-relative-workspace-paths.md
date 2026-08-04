# ADR-0006: Descriptor-relative workspace paths

- Status: Proposed — human approval required
- Date: 2026-08-04
- Owners: Workspace runtime / sandbox security

## Context

PRD §16.3 requires tool paths to stay inside the workspace root and prohibits
symlink traversal outside it. Plan 03 repeats that contract for WS-1 and requires
WS-3 to enforce it again inside the workspace-agent daemon.

The current TypeScript guard resolves and checks a real path, then performs the
file operation or process spawn in a later system call. An untrusted workspace
process can replace a checked directory with a symlink between those calls. A
review probe used that race to make the file API read outside the workspace;
write and command `cwd` have the same check-then-use gap.

Node.js 22 exposes pathname-based `open` and pathname-based child-process `cwd`,
but no `openat`/`openat2` or `fchdir` interface. `O_NOFOLLOW` on only the final
pathname component does not protect ancestor components or prevent an escaping
`O_CREAT` side effect. A complete fix therefore cannot be expressed through the
locked TypeScript interface alone.

## Proposed decision

Add a small, auditable POSIX helper executable to `sandbox/workspace-agent` and
expand WS-3's Files contract to include its source, build script, and tests. The
HTTP API and `WorkspaceRuntime` interfaces remain unchanged.

The helper will:

- open the workspace root once as a directory descriptor;
- walk every relative path component with descriptor-relative `openat` calls,
  `O_NOFOLLOW`, and directory/type checks, never re-resolving a checked prefix;
- implement file read, write, and directory-list primitives against the pinned
  descriptors;
- implement exec by opening the requested `cwd` the same way, calling `fchdir`,
  and then `execvp`; execa and node-pty launch the helper, so buffered and PTY
  behavior remain owned by the existing TypeScript process manager;
- return distinct, non-secret exit statuses that the daemon maps to the existing
  stable 400 `bad_request` response for path violations.

Use `openat2` with `RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS` on Linux when available,
with a component-by-component `openat` implementation for supported macOS and
older Linux test hosts. Build the helper with the platform C compiler already
required by the base image's `build-essential`; add no new runtime or vendor.
Package and smoke tests must fail if the helper is absent or not executable.

Deterministic tests will pause the helper after a parent descriptor is opened,
swap the pathname to an outside symlink, then prove read, write, list, buffered
exec, and PTY exec either use the pinned in-root object or reject the request.
No outside read or write side effect is acceptable.

## Consequences

- WS-3 gains native source and cross-platform build coverage, increasing review
  and packaging work. WS-2 must bake the compiled helper alongside the daemon.
- The public runtime and API contracts do not change, so WS-4 and desktop
  adapters do not need a second protocol.
- Descriptor-relative operations close the race rather than narrowing its
  timing window. The existing lexical/realpath checks remain useful for early,
  readable rejection but are no longer the security decision.
- The helper supports the cloud Linux sandbox and macOS development/tests. A
  future Windows workspace-agent port requires a separate superseding ADR or a
  Windows handle-relative implementation.
- WS-3 remains blocked and unchecked until this ADR is accepted and the helper,
  race tests, package checks, and original conformance suite are green.

## Rejected alternatives

- Accept the JavaScript race because code already runs in a sandbox: the PRD
  names path traversal as a mandatory defense-in-depth control, and the file API
  should not become an unscoped filesystem API merely because exec is powerful.
- Add only `O_NOFOLLOW` to final file opens: ancestor swaps and escaping creates
  remain possible, and command `cwd` is still path-based.
- Re-check `realpath` after access: an outside read or write has already happened
  before the second check, so detection does not provide containment.
- Add a general N-API filesystem/process addon: it expands the native ABI surface
  and would duplicate stream/process ownership. A narrow exec/file helper keeps
  the TypeScript daemon in control of HTTP, buffering, PTY, timeout, and kill
  semantics.
- Chroot the daemon into the workspace: the agent also needs toolchains and the
  baked `/opt/zapp` runtime; reproducing those mounts per workspace widens WS-3
  into the image and sandbox-provider tasks.
