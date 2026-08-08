# ADR-0022 — Lean P0 re-scope: CI re-enabled, WS-3 guarded-write proof moved to WS-4, process diet, ops deferrals

**Status:** Accepted (product owner, 2026-08-08)

## Context

Five days of execution (2026-08-03 → 2026-08-08) produced 384 commits at a sustained
~3.6/hour, but the task-close rate collapsed from 26 tasks on day 1 to ~1–5/day by day 5
(62/177 done). A forensic pass over git history, execution logs, lessons, and the plans —
compared line-by-line against the PRD — identified where the yield went:

1. **Review loops chasing heuristic completeness.** Eight tasks hit the five-round cap
   (AR-1, AR-3, AR-4, AR-5, AR-7, GIT-4, CP-15, WS-10); AR-5 ran 14 rounds before
   ADR-0016 ended it by re-scoping. ADR-0016/0017 named the failure but arrived day 4.
2. **Bookkeeping cadence.** ~1:1 alternation of one-line `docs: record …` commits with fix
   commits; `tasks/todo.md` churned 70×; 39 commits changed exactly one line. The PRD
   mandates none of the per-task ceremony (TDD/ADR/execution-log/review-round: 0 occurrences).
3. **Per-round real-provider verification.** WS-2 ran ~13 full Modal publish/smoke cycles;
   ≥5 base images were built and discarded; most failures were environmental.
4. **An acceptance criterion above the PRD bar on the critical path.** WS-3's "blocking
   guarded-write acceptance" required WS-4's production runtime to prove revision-CAS
   semantics the PRD never asks for ("atomic"/"CAS"/"revision": 0 occurrences). WS-3 was
   otherwise fully green (daemon 7/7, suite 91/91, WS-1 conformance 35/35, real Modal
   smoke vs `2026-08-08-c58a416`) and stood blocked on it.
5. **Local gate machinery substituting for parked CI.** GitHub Actions was billing-parked;
   9 M1-GATE repair tasks and 6 "CI billing-blocked" annotations exist only because of it,
   and 3 of 5 lessons in `tasks/lessons.md` are the local gate certifying the wrong thing.
6. **P0 ops tasks with no PRD basis.** OPS-9 (k6 10× load rig + capacity model), OPS-15
   (DR runbooks + quarterly drills), OPS-16 (SOC 2 readiness pack), OPS-18 (incident
   response + public status page). PRD §5 non-goals explicitly exclude custom compliance
   programs.

On 2026-08-08 the product owner approved this re-scope and made the repository public,
restoring free, unmetered GitHub Actions.

## Decision

1. **WS-3 is unblocked and accepted.** The "Blocking guarded-write acceptance" clause is
   struck from WS-3. WS-3's own contract is the fail-closed typed atomic-write conflict
   whenever its backing provider cannot enforce revision CAS — implemented and proven in
   the shared conformance suite. The production proof (guarded patch commit + deterministic
   final-window conflict with zero target writes across the full writer domain) lives solely
   in WS-4 step 4b, where the production cloud runtime exists. Compare-then-rename and
   non-compulsory locks remain forbidden substitutes.
2. **GitHub Actions is the authoritative gate again** (re-enabled 2026-08-08). The local
   pre-push `pnpm verify` hook stays as a fast pre-flight; no further local gate machinery
   is built or repaired — if local and CI disagree, CI (a clean cold machine) wins and the
   fix is a normal task. "CI billing-blocked" annotations are obsolete.
3. **Review cap drops to two rounds per task**, with the exit condition declared before
   round 1. ADR-0017 severity rules are enforced as written: a bypass of a heuristic the
   architecture does not rely on is at most Minor and never spends a round.
4. **Real-provider verification runs once per task, at its final acceptance gate** — never
   per review round. Review rounds re-run local suites only. Published immutable images are
   consumed from `images.lock.json`, not rebuilt.
5. **Recording diet.** `tasks/todo.md` is the single authoritative tracker (plan-file
   checkboxes optional). One execution-log line per **completed** task, summarizing any
   blockers hit; bookkeeping rides the task's own commit. No standalone one-line docs
   commits.
6. **OPS-9, OPS-15, OPS-16, OPS-18 are deferred post-P0** (they return before public
   beta). OPS-8/10/12/13/14/17, CP-17/18, DEP-11 and the entire security/tenancy/billing
   surface remain in P0 — those are PRD-mandated.

## Consequences

- The M1 critical path resumes immediately: WS-3 checked, next task WS-4.
- Process-generated repair work (M1-GATE-style tasks) stops being created; CI covers cold,
  clean-machine verification structurally.
- Master plan §5/§6 references to the deferred tasks are annotated rather than rewritten;
  the enterprise-readiness rows they served (capacity model, DR drills, SOC 2 pack, status
  page) are explicitly post-P0, pre-public-beta. Backups themselves (Neon PITR, logical
  dumps, nightly Git bundles — GIT-4) stay in P0.
- `AGENTS.md` §§2/3/4/5/9 and master plan §8 are updated in the same commit as this ADR.
