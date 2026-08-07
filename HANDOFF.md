# zapp.build — Handoff (2026-08-04)

State of the build, what's pending, and how to resume. Written for a fresh AI coding
session with no memory of prior work.

---

## 1. Where we stand

**M0 is complete and signed off.** 25/25 M0 tasks implemented, each independently
reviewed with fix rounds, verified by an adversarial gate check against the running
system (not against task reports). Sign-off with the evidence table is in
[`docs/plans/00-master-plan.md`](docs/plans/00-master-plan.md) under "M0 gate sign-off".

- **HEAD:** `f1b56a8`, in sync with `github.com/crossbizz/zapp` `main`. Working tree clean.
- **Tracker:** 29 boxes checked, 139 open (M1–M6 plus gate follow-ups).
- **CI:** 9 jobs across 3 workflows, all green — `checks`, `integration tests`,
  `tenant isolation (M0 exit criterion)`, `git isolation (repository-scoped tokens)`,
  `package macOS app`, `preserve suite (macOS)`, `gitleaks`, `osv-scanner`,
  `license boundary`.

### What exists

| Package/service | What it is |
|---|---|
| `packages/contracts` | Zod-first domain contracts: 34 agent-event types, 26 TypeID prefixes, 45-tool registry, sandbox/adapter/deployment interfaces, execution contract (strict), API envelope. 125 tests. |
| `packages/db` | Full PRD §23 schema (28 tables) + partitioned `agent_events` + tenant-scoped repositories. **A conformance test re-parses the PRD on every run** and diffs all 28 tables both directions. 138 unit + 46 integration tests. |
| `packages/config` | `defineEnv`, service-token sign/verify, credential gates that reject `replace-me` placeholders. 32 tests. |
| `packages/eslint-rules` | `no-dyad-pro-imports` (license boundary). 29 tests. |
| `services/control-api` | Fastify control plane: Stytch auth + device consent, RBAC (PRD §22.2, 27 cells), tenant plugin, audit-in-transaction, idempotency, proxy-aware rate limits, secrets vault, service tokens, project lifecycle. 335 unit + 126 integration + **46 isolation** tests. |
| `services/git-service` | Forgejo-backed internal Git: repo-per-project, repository-scoped short-lived tokens (Forgejo has neither natively — both were built), in-process expiry sweep. 118 unit + 15 integration. |
| `apps/desktop` | Dyad v1.9.0 fork, `src/pro` removed (byte-verified across all history), zapp identity CI-asserted, updater neutralized, 7-spec capability preservation suite. |

### Explicitly NOT verified (no credentials exist yet — do not read the green board as covering these)

- **Stytch against a real IdP** — all auth logic tested against `FakeAuthPort`; the live suite skips loudly.
- **macOS signing + notarization** — steps written, skipped on every run. MAC-2's core claim has never executed.
- **Docker runtime preservation**, **Modal / Temporal / LocalStack** — no test reads `MODAL_*` at all.

---

## 2. RESOLVED — Forgejo stays (see ADR-0018)

**Decision, 2026-08-07: internal Git stays Forgejo; GitHub remains an optional peer
remote. No code removed.** Rationale and rejected alternatives in
[`docs/adr/0018-internal-git-stays-forgejo.md`](docs/adr/0018-internal-git-stays-forgejo.md).
The short version: PRD §19.1 promises the product works *without* a user GitHub account,
which the activation flow and the agency persona both depend on; GitHub already has its
designed place as a peer remote (plan 06 INT-1..4). The accepted cost is that we operate a
stateful service; the exit hatch is swapping `GitProvider` to a managed host — not making
users have GitHub accounts.

The original framing is preserved below for context.

## 2b. Original open question (now answered by ADR-0018)

**The product owner said "we don't need Forgejo, the repository is already initialized
with GitHub, just use that."** This was not resolved.

The likely mix-up: Forgejo has never hosted the zapp repo (GitHub always has). Forgejo
hosts the repos of the **apps zapp builds for users** — one per customer project —
because PRD §19.1 requires that *"zapp.build must work without requiring a user GitHub
account."* GitHub is a *peer* remote users may optionally connect (plan 06 INT-1..4, unbuilt).

Three readings, pick one before touching `services/git-service`:

1. **No change** — our repo is on GitHub already; Forgejo stays for customer projects.
2. **GitHub becomes the product's Git backend** — real product change: every user needs
   a GitHub account, needs a GitHub App with repo-creation scope, PRD §19.1 gets amended,
   GIT-1/2/3 (~4k lines, reviewed + CI-gated) get deleted, plan 06's INT tasks become the
   primary path.
3. **Keep Forgejo but make it opt-in in the local dev stack** — if the concern was
   docker-compose noise.

Do not delete `services/git-service` on ambiguity. It is reviewed, CI-gated, and its
cross-repo denial test is the only thing proving customer repos are isolated from each other.

---

## 3. Where the latest state lives

| File | What it holds |
|---|---|
| [`docs/zapp-build-prd.md`](docs/zapp-build-prd.md) | **The source spec (v1.1, 3,188 lines).** Every plan task cites it by section — §14.4 event catalog, §16.1 tool list, §17.2 execution contract, §22.2 RBAC matrix, §23 data model, §24.2 verification gates, §32 API surface, §39 P0 exit criteria. Treat it as background you consult by citation, **not** as scope to re-derive: the plans already translated it, and where they knowingly diverge the deviation is recorded in that plan's Execution log. It is also a *live* artifact — `packages/db/test/prd-schema-conformance.test.ts` parses §23 on every CI run and fails if the schema and the PRD disagree in either direction, so editing the PRD's §23 tables breaks the build until the schema follows. |
| [`docs/plans/00-master-plan.md`](docs/plans/00-master-plan.md) | **Read first.** Locked stack decisions (§2 — several supersede PRD §35 suggestions), Global Constraints (PRD §42 guardrails), milestones M0–M6 with exit criteria (§4), execution model (§8), and the M0 gate sign-off at the end. |
| [`tasks/todo.md`](tasks/todo.md) | Live checkbox tracker, grouped by milestone. Also holds the **M0 gate findings** section (GATE-1..7) with what's closed and what carried forward. |
| `docs/plans/01`–`10` | Per-workstream plans. Every task carries Files / Interfaces / Steps. **Each plan's `## Execution log` at the bottom is the real history** — deviations, folds into later tasks, and blockers found by review. Read the log for a plan before starting any of its tasks. |
| [`AGENTS.md`](AGENTS.md) | Binding agent instructions: task loop, definition of done, honesty rules, credential table. |
| [`tasks/lessons.md`](tasks/lessons.md) | Corrections that became rules (e.g. verify push gates from a clean checkout, never the working tree). |
| `docs/adr/0001-0003` | Locked decisions, Dyad fork, sandbox file-io/preview-revocation gaps for plan 03. |
| `.superpowers/sdd/progress.md` | Per-task ledger (git-ignored; recovery map if context is lost). |

**Carried-forward blockers recorded in plan execution logs — read these before the named task:**

- **plan 07 (before DEP-1):** Forgejo's `release/*` protection refuses even the platform
  **admin** token — proven by a real push in `git-service`'s integration suite. The release
  service cannot cut release branches over git as assumed. Resolve via API branch-create,
  `apply_to_admins`, or tag-only releases.
- **plan 02 (before CP-13):** `agent_events` has no `project_id` column (PRD §23.4 omits it)
  though `AgentEventSchema` carries `projectId`. Add a one-line migration or join `agent_runs`.
  Also: the payload cap must be measured in **bytes** (`Buffer.byteLength`), matching the DB
  CHECK, and `runId` must be resolved within the tenant *before* calling `nextEventSequence`.
- **plan 03 (WS-4 / WS-12):** ADR-0003 — PRD §18.2's `readFile`/`writeFile` carry no
  workspace binding, and `PreviewHandle` has no revocation identifier despite §18.11
  requiring revocable sessions. Amend the provider interface there.
- **plan 10 (OPS-13):** 57 osv findings remain, **100% in the vendored `apps/desktop` tree**.
  Everything outside it is vulnerability-free. `electron 40.8.5` is worth 18 findings but
  **reproducibly fails the desktop PTY preserve test** — needs triage, and note CI's
  `retries: 2` would likely mask it.
- **plan 10 (ops runbook):** rate-limit proxy trust defaults to **none**. Any deploy behind
  an edge proxy must set `proxy.trustedHops` in `config/rate-limits.json` in the same change.

---

## 3a. Current state as of 2026-08-06 (supersedes §1 counts)

M1 is **18 of 35 tasks done**. Verified by counting `tasks/todo.md` directly.

**Done:** CP-9…CP-16 (all eight — control plane API, event ingest, Redis fanout, resumable
SSE, generated SDK), WS-1, GIT-4, AR-1, AR-2, AR-4, AR-7, WEB-1, WEB-2, WEB-3, WEB-5.

**The bottleneck is the sandbox chain.** WS-2…WS-12 are all open, and they are what M1's
exit criterion actually needs (prompt → Modal workspace → live preview). Everything else
remaining is comparatively small: AR-3, AR-5, AR-6, AR-8, WEB-4, WEB-6.

**Critical path, in order:**

1. **WS-10** (preview proxy) — blocked; blocks WS-2. Rewrite the HTML injection with
   `parse5` per ADR-0017.
2. **WS-2** (Modal images) — bakes the proxy + agent into the images.
3. **WS-3** (workspace agent) — branch `task/WS-3` already passed independent review;
   only smoke verification is pending. Salvage, do not restart.
4. **WS-4 → WS-12** — Modal provider, git clone/push, lifecycle, checkpoints, profiles,
   secrets injection, preview tokens.
5. In parallel (disjoint packages): **AR-5** → **AR-6** → **AR-8**; **AR-3**; **WEB-4**,
   **WEB-6**.

### Branch dispositions (agents were stopped mid-flight; nothing is lost)

| Branch | Commits ahead | Disposition |
|---|---|---|
| `task/WS-3` | 11 | **Salvage** — reviewed and approved, smoke pending |
| `task/WS-2-resume` | 26 | **Salvage** — WS-2 work; re-verify against the rewritten proxy |
| `task/WS-10`, `task/WS-10-resume` | 4, 13 | **Partial salvage** — keep the proxy, WebSocket forwarding, capture client and SSE endpoint; **discard only the hand-written HTML injection scanner** (its two capped blockers were unquoted `src` and `<style>` raw-text — both HTML-parsing). Replace with `parse5`. |
| `task/AR-3`, `task/AR-3-resume` | 8, 7 | **Salvage** — fix the two real accounting defects (recorder reports `provider_error` instead of `usage_accounting_failed`; OTel attribute writes can prevent `span.end()`) |
| `task/AR-5`, `task/AR-5-resume` | 6, 20 | **Abandon** per ADR-0016 — 1,760 lines of shell/SQL/NL analyzer. Rewrite from the re-scoped brief. Do not merge, do not mine for logic. |
| `task/WEB-4` | 1 | Minor; re-verify before continuing |
| All `task/*` at 0 ahead | 0 | Already merged; ignore |

No branch is deleted — the history is intact if any decision here proves wrong.

## 4. Next milestone — M1: prompt → Modal workspace → live preview

**M1 exit criterion (master plan §4):** in the browser, sign in → home prompt → project
created from a template → Modal sandbox boots → dev server runs → **authenticated preview
renders beside the chat** → a Builder agent applies a chat-requested edit → commit lands in
internal Git → **sandbox killed mid-run and the project resumes from durable state**.

38 tasks. Suggested order (parallel lanes are disjoint by package):

| Lane | Tasks | Notes |
|---|---|---|
| **Control plane** | CP-9 → CP-16 | CP-13/14/15 (event ingest → Redis fanout → resumable SSE) is the spine everything else renders from. CP-16 generates the SDK the web app consumes. |
| **Sandbox** | WS-1 → WS-12 | **WS-1 first** — it defines `WorkspaceRuntime`, which plan 09's local/Docker modes also implement. WS-2 (Modal images) needs a Modal token. |
| **Agent runtime** | AR-1 → AR-8 | AR-1 (model gateway) needs one provider key. AR-8 is the M1 walking skeleton: a durable chat run that survives a worker restart. |
| **Web** | WEB-1 → WEB-6 | WEB-2 (`packages/ui`) must build under both Next and Vite — plan 09 reuses it. WEB-3 is the Emergent-modeled home screen; the layout spec is in plan 08 with exact tokens. |
| **Git** | GIT-4 | Nightly bundle backups. Blocked on the Forgejo decision above. |

**Credentials M1 needs** (AGENTS.md §10): Modal token (dev environment), Stytch test
project, one model-provider key (Anthropic). Without them: WS-2/WS-4, CP-2's live auth
suite, and AR-1 skip visibly. Everything else builds against fakes.

---

## 5. Prompt to resume

Paste this into a fresh AI coding session at the repo root:

```text
Read AGENTS.md, HANDOFF.md, docs/plans/00-master-plan.md (especially §2 locked decisions,
Global Constraints, §4 milestones, and the M0 gate sign-off at the end), and tasks/todo.md.

The product spec is docs/zapp-build-prd.md (v1.1). Don't read it end to end — the plans
already translated it into tasks. Read the specific sections a task cites, and treat the
plan as authoritative where the two differ, because several locked decisions in master §2
deliberately supersede PRD §35 suggestions (Stytch not WorkOS, Grafana Cloud not Sentry,
Flexprice for metering, AWS SQS/SNS/SES with LocalStack). Note §23 is load-bearing: a test
parses it every CI run and fails if the PRD and the Drizzle schema disagree, so a PRD edit
there is a code change.

M0 is complete and signed off; M1 is next. Before starting any task, read the owning plan's
`## Execution log` at the bottom of docs/plans/<NN>-*.md — it records deviations and blockers
that later tasks depend on, and HANDOFF.md §3 lists the carried-forward ones by task.

Execute M1 following the AGENTS.md task loop: one task at a time, TDD (failing test first,
run it, watch it fail for the right reason), verify with real command output, commit with the
message the plan specifies, then check the box in BOTH the plan file and tasks/todo.md and
append a line to that plan's Execution log.

Order: WS-1 first (it defines the WorkspaceRuntime interface that plan 09 also implements),
then CP-9..CP-16 and AR-1..AR-8 in parallel with WEB-1..WEB-6 — those lanes touch disjoint
packages. GIT-4 is blocked pending the Forgejo/GitHub decision in HANDOFF.md §2; do not
delete services/git-service without an explicit answer.

Non-negotiables that have already caught real defects here, so honor them literally:
- Verify from a clean checkout of HEAD before pushing, never from the working tree
  (tasks/lessons.md explains why — this reddened main once).
- A test that cannot fail is worse than no test. When you add a guard, prove it fires by
  breaking the thing it guards, then revert. Report the evidence.
- Credential-gated suites must skip LOUDLY with a named reason and must throw in CI rather
  than skip green. Never convert a skip into a pass claim.
- A security property that isn't a CI gate isn't a property. Tenant isolation and
  cross-repo denial each have their own job for this reason.
- No Modal SDK outside services/sandbox-service; no model-provider calls outside
  services/model-gateway; secrets never enter logs, events, or model context.

I don't have Modal, Stytch, or model-provider credentials yet. Build against the existing
fakes/ports, make the gated suites skip visibly, and tell me exactly which suites are
unverified rather than working around the absence.

Start by reporting your plan for WS-1, then implement it.
```

---

## 6. How the work has been executed (worth preserving)

Each task: a fresh subagent implements it TDD-style, an independent reviewer adversarially
verifies the diff against the brief, findings become a fix round, and the reviewer re-verifies.
Reviewers ran mutation checks — breaking the mechanism to prove the test catches it.

That loop caught, among others: a device-flow link that yielded another user's 30-day refresh
token; a rate limiter that locked out all sign-ins behind a proxy while limiting no attacker;
an isolation suite proving a composition the server never performed; a preservation suite that
ran in no test directory; a security suite that silently skipped 15/15; a Stytch test that
passed with garbage credentials; a Desktop workflow that had never once been green; and a token
system promising 600-second TTLs while nothing expired anything, on a host with a public IP.

None of those would have been caught by tests alone — they were all cases where a green signal
wasn't evidence.
