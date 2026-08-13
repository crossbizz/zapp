
## 2026-08-04 — Verify push gates against committed state, not the working tree

**What happened:** A migration adding TRUNCATE guards landed on main. Its required
test-harness repair existed only as uncommitted work in a subagent's tree. I ran the
integration suite locally, saw green, and released the push hold — CI went red on the
3 tests the guards broke.

**Why:** The local run used the dirty working tree, which contained the fix. The
pushed commit did not.

**Rule:** When a hold exists because commit A needs commit B, verify from a clean
checkout of HEAD (`git worktree add` / `git archive`), never the working tree. A green
local run only proves the tree is green, not that main is.

**Related:** turbo `lint` also needed `dependsOn: ["^build"]` — type-aware lint rules
resolve workspace imports through `dist/`, so a cold CI checkout reported `no-unsafe-*`
errors that never reproduce locally where `dist/` survives from earlier builds.

## 2026-08-07 — Test a hook through its production caller, not an approximation

**What happened:** The new pre-push verify gate passed a direct simulation but
silently never fired on a real push. The managed wrapper hook pipes the ref list
via `_input="$(cat)"` + `printf '%s' "$_input"` — command substitution strips the
trailing newline and `printf '%s'` doesn't restore it. The gate's `while read`
loop returns non-zero on an unterminated final line, so its body never ran,
`remote_ref_is_main` stayed 0, and the hook exited 0. My simulation used `echo`,
which adds the newline the production path lacks.

**Why:** I verified my mental model of the caller instead of the caller. One
byte of difference (a missing `\n`) turned the gate into a no-op that *looked*
verified.

**Rule:** A guard is verified only when exercised through the exact production
entry point — the real wrapper, the real stdin shape, the real env. If the
production path can't be run directly, reproduce its transport byte-for-byte
(here: `printf '%s'`, not `echo`). And any `while read` over externally-supplied
input gets the `|| [ -n "$var" ]` unterminated-final-line guard by default.

**Related:** the gate now lives tracked at `scripts/git-hooks/pre-push.local`
and is installed by `scripts/dev-up.sh` — .git/hooks is untracked, so without
the installer a fresh clone has no gate at all (same silent-disarm failure,
different mechanism).

## 2026-08-07 — A gate must pin the environment it certifies

**What happened:** The armed pre-push gate went red with deadlocks, FK
violations on rows that had just been inserted, and `organization_not_found`
404s that changed from run to run. The hook sourced `.env` for connection
strings — and `.env`'s `DATABASE_URL` pointed at a shared remote Neon endpoint
(live M4 prep config), not the local stack. Every "local" suite ran against a
database other concurrently-working agents were truncating. Meanwhile the
hook's own `pg_isready -h localhost` probe guarded a database the tests never
touched. Three debugging detours (CPU contention, IPv6, macOS Docker fsync)
were all artifacts of measuring against the wrong database.

**Rule:** A verification gate pins every piece of infrastructure it certifies
— explicitly, in the gate itself — rather than inheriting live developer
config. If a guard probes X, the thing it guards must run against X; guard and
testee reading different config is the same silent-disarm failure as a skipped
suite. And when a latency number looks impossible, check *where* the traffic
goes before theorizing about *why* it is slow: a TLSSocket frame in a stack
trace for a "localhost" database was the tell.

## 2026-08-07 — Re-scope work that exceeds ten minutes

**What happened:** Correctness work could expand into repeated race hunting,
heuristic hardening, or audit-driven edge cases while the end-to-end product
path remained incomplete.

**Rule:** At 15 minutes, classify the delay. If the product-critical path is
blocked by a race, heuristic, flaky test, or review/audit edge case, stop the
grind: preserve structural security and real correctness, re-scope to the
smallest load-bearing contract, document the disposition in the owning plan's
Execution log, and move on. A failed required check remains failed and a
blocked task remains unchecked; re-scoping never turns missing evidence into a
pass. A prescribed local gate may run longer while its process is healthy and
making progress, but do not restart or broaden it merely to chase marginal
coverage. Rethink is this task even needed, or can be modified to achieve our goals safely and reliably.

## 2026-08-08 — Re-scoping means continue, not stop

**What happened:** A load-bearing task was re-scoped into a small diagnostic
contract, but execution stopped to request approval even though the human's
standing objective already authorized normal in-scope work needed to finish the
application.

**Rule:** When a terminal objective says to finish all milestones, an in-scope
diagnostic, observability improvement, or repair needed to remove a proven
blocker does not require another approval. Re-scope it, record it, and continue.
Stop only when progress needs genuinely new authority, a vendor/architecture
substitution, destructive action, or a plan conflict the existing instructions
do not resolve.

## 2026-08-13 — Worktree progress is not authoritative completion

**What happened:** Parallel milestone branches contained substantial finished
work, but the primary branch tracker still showed dozens of open tasks. Reporting
the branch work as if it were integrated made the completion status wrong.

**Rule:** Reconcile and integrate the selected commits into the authoritative
branch before reporting milestone counts. Derive completion from that branch's
tracker and fresh verification, never from a task report or another worktree.
