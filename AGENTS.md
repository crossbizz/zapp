# zapp.build — Instructions for AI Coding Agents

You are implementing **zapp.build P0** from a complete, pre-authored plan set. Your job is **faithful execution of the plans, not re-design**. The thinking has been done; deviations are exceptions with a paper trail, not improvements made on the fly.

## 1. Sources of truth (precedence order)

1. [`docs/plans/00-master-plan.md`](docs/plans/00-master-plan.md) — locked stack decisions (§2), Global Constraints, milestones + exit criteria (§4), execution model (§8)
2. The workstream plan that owns your current task (`docs/plans/01`–`10`) — each task's **Files / Interfaces / Steps / Acceptance criteria are binding contracts**
3. [`tasks/todo.md`](tasks/todo.md) — execution order and live status
4. [`docs/zapp-build-prd.md`](docs/zapp-build-prd.md) — background spec; consult the sections a task cites (e.g. "PRD §24.2"), don't re-derive scope from it

If sources conflict: master plan §2 + Execution log entries win; otherwise **stop and ask the human**. Never silently reinterpret a plan.

## 2. Non-negotiables

Read master plan **§Global Constraints** (all 20) before your first task. The most commonly violated ones:

- No Modal SDK calls outside `services/sandbox-service`; no model-provider calls outside `services/model-gateway` (Semgrep-enforced later, honor it from day one).
- No secret values in code, logs, events, fixtures, or committed `.env` files. Real keys live only in untracked `.env`; `.env.example` gets names only.
- Zod at every service boundary; types inferred from schemas, never duplicated by hand.
- Table/column/route/event/tool names come from the plans (which mirror the PRD) — do not "improve" naming.
- Every mutating API/activity is idempotent or keyed. Cross-tenant reads return 404, never 403.
- No code derived from Dyad `src/pro`, ever.
- A failed check can never be reported as success — not by generated code, and **not by you** (see §5).
- **Structural over heuristic (ADR-0011/0012).** A guarantee lives in a structural control (credential scope, sandbox/network profile, approval gate, tool allowlist, a declarative lint rule) — never in a string/NL/AST/HTML heuristic's completeness. A demonstrated bypass of a heuristic the architecture does not rely on for containment is at most a Minor review finding; block only on a structural-control gap or a real correctness/security defect. Prefer maintained OSS for solved problems (HTML rewriting, import bans, unused-dep/empty-catch/duplication detection, DAG scheduling, attack corpora) — build custom only for genuinely zapp-specific value. On a five-round review cap, re-scope and escalate; never grind another round on an undecidable problem.
- **API first** (product-owner directive 2026-08-03): every capability ships as a versioned `/v1` API (+ generated SDK) before or alongside any UI; clients only ever consume the public API/SDK — no UI-private backdoors.

## 3. The task loop (one task at a time)

1. **Pick** the next unchecked task in `tasks/todo.md`, top-to-bottom within the current milestone. Within a milestone, plans may run in parallel (see §8) but a single agent works one task at a time.
2. **Load context minimally**: the task block, its plan's header + Global Constraints section, and the interfaces it consumes (named in the task). Don't read the whole PRD or unrelated plans into context.
3. **Expand if marked `[expand-at-execution]`**: before coding, expand the task into full TDD steps (failing test → run → implement → pass → commit per step). The task's Files/Interfaces/Acceptance criteria bind the expansion. Write the expansion into the plan file under the task, then execute it.
4. **TDD**: write the failing test named in the task first; run it and confirm it fails for the right reason; implement minimally; run again and confirm green.
5. **Verify**: run the task's verify commands (and `pnpm lint && pnpm typecheck` on touched packages). Show real output.
6. **Commit** with the task's specified commit message (one task = one commit unless the task defines per-step commits).
7. **Record**: check the box in the plan file **and** `tasks/todo.md`; append one line to the plan's `## Execution log`: `YYYY-MM-DD <TASK-ID> done — <one-line note / deviation>`.
8. **Report** (see §7), then move to the next task with fresh context (start a new session/subagent per task if your harness supports it).

## 4. Definition of done (per task)

A task is done only when ALL of these are true — otherwise it stays unchecked and you say so plainly:

- [ ] Every step in the task checked off, tests written before implementation
- [ ] Verify commands pass with output shown (paste the trailing lines, not "tests pass")
- [ ] No files touched outside the task's Files list except imports/exports it explicitly requires
- [ ] Committed with the prescribed message; boxes checked in plan + tracker; execution log line appended
- [ ] No TODO/FIXME/placeholder/`skip`ped test introduced (the platform's own anti-slop rules apply to you)

## 5. Honesty rules

- Never mark a box, write "done", or claim green without having run the command in this session.
- If a test can't run (missing external credential), it must **skip visibly** (env-gated per the plan), and your report must say "skipped: no `STYTCH_SECRET`" — never convert a skip into a pass claim.
- If you wrote code you couldn't verify, say exactly that and list what's unverified.

## 6. Blockers, deviations, decisions

- **Blocked** (missing credential, upstream API mismatch, plan contradicts reality): stop the task, append a `BLOCKED:` line to the plan's Execution log with specifics, report, and move to the next non-dependent task.
- **Deviation needed** (an interface won't work as specified, a pinned lib is broken): do NOT improvise. Propose the change as a short ADR in `docs/adr/NNNN-*.md` (context → decision → consequences), get human approval, then update the plan text + code together.
- **Locked decisions** (master §2: Stytch, Neon, Stripe, Flexprice, Grafana Cloud, PostHog, Forgejo, Fly.io, Modal, Temporal, R2, Upstash): never substitute, "temporarily stub with X", or add a parallel vendor. Fakes/ports for tests are already designed into the plans — use those.
- **Ambiguity inside a task**: choose the reading consistent with the PRD section it cites, note the assumption in the Execution log, continue. Ambiguity about scope → ask.

## 7. Reporting format (after every task)

```
✅ <TASK-ID> <title>
Shipped: <1–2 lines>
Verified: <command> → <trailing output line(s)>
Skipped/unverified: <list or "none">
Next: <TASK-ID>
```

At each milestone boundary, STOP feature work and run the milestone's exit checklist from master plan §4 as its own session; failures become fix tasks before the next milestone starts.

## 8. Parallelism (if your harness supports multiple agents/worktrees)

- Parallelize **across plans**, never within one plan: e.g. in M0, one agent on Plan 01 (FND), one on Plan 09 (MAC) once FND-1 lands.
- One git worktree/branch per agent; merge order follows the dependency graph in master §1.
- Never two agents in the same package/service concurrently.

## 9. Git

- Trunk-based. Serial execution commits directly to `main` (controller decision 2026-08-03); `task/<TASK-ID>` branches become mandatory once parallel agents start. After FND-8 lands, CI must be green before push.
- Small commits, prescribed messages. Never rewrite published history. Never commit `.env`, keys, or generated secrets.

## 10. External credentials by milestone

Ask the human for these as each milestone starts; until provided, env-gated tests skip:

| Milestone | Needs |
|---|---|
| M0 | none (docker-compose only) |
| M1 | Modal token (dev env), Stytch test project, one model-provider key (Anthropic) |
| M2 | remaining model providers (OpenAI, Gemini), Temporal Cloud (or keep local dev server) |
| M4 | GitHub App (test org), Supabase, Neon, Stripe test mode, Vercel token, Fly.io org |
| M5 | Flexprice, Grafana Cloud stack + OTLP token, PostHog, Resend/SES, Stripe webhooks endpoint |

## 11. Session hygiene

- One task per session/context window. Re-read nothing you don't need.
- Long task? Finish the current TDD step, commit, and continue in a fresh session — the plan file + tracker are your memory, not the chat.
- Update `tasks/lessons.md` when the human corrects you; read it at session start.
