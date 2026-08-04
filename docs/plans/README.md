# zapp.build P0 Plan Set

Source spec: [`docs/zapp-build-prd.md`](../zapp-build-prd.md) (v1.1, 2026-08-03). UX benchmark: app.emergent.sh home + PRD §10/§26A UX contracts.

## Read in this order

1. [`00-master-plan.md`](00-master-plan.md) — architecture decisions, milestones M0–M6, scalability & enterprise readiness, risk register, execution model. **Start here.**
2. Workstream plans `01`–`10` — detailed, task-numbered implementation plans (FND/CP/WS/AR/VF/GIT/INT/DEP/WEB/MAC/OPS prefixes).
3. [`../../tasks/todo.md`](../../tasks/todo.md) — the checkable master tracker, grouped by milestone.

## How to execute

- Execute tasks with superpowers:subagent-driven-development (one task per fresh subagent) or superpowers:executing-plans, in milestone order from `tasks/todo.md`.
- Each task ends with a commit; check the box in both the plan file and the tracker; log deviations in the plan's `## Execution log`.
- Tasks marked `[expand-at-execution]` must be expanded into full TDD steps (superpowers:writing-plans) before coding — their Files/Interfaces/Acceptance criteria are binding.
- Deviating from a locked decision (master §2) requires an ADR in `docs/adr/`.

## Plan index

| Plan | Scope | Milestones |
|---|---|---|
| 01 Foundation | Monorepo, contracts, db, dev env, CI | M0 |
| 02 Control plane | Auth, tenancy, RBAC, secrets, audit, SSE, SDK | M0–M1, M5 |
| 03 Workspace/sandbox | Modal provider, images, agent, preview proxy, lifecycle | M1–M2 |
| 04 Agent runtime | Model gateway, tools, Temporal, modes, task graph, spec/plan engines | M1–M3 |
| 05 Verification | Adapters, gates, Playwright, browser agent, verifier, repair, evidence | M2–M3 |
| 06 Git & integrations | Forgejo, GitHub App, Supabase, Neon, Stripe-in-apps | M0–M1, M4 |
| 07 Deployment & releases | Release service, readiness, Vercel/Fly, rollback, domains, synthetics | M4 |
| 08 Web & UX | Design system, Emergent-modeled home, builder, Mission Control, deploy UX | M1–M5 |
| 09 macOS app | Dyad fork, rebrand, local/Docker/cloud modes, sync | M0, M2–M5 |
| 10 Billing/obs/security | Ledger + Flexprice metering, Stripe billing, OTel→Grafana Cloud, PostHog analytics+flags, security program, support | M2, M5 |
