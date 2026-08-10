# Cross-plan interface audit — 2026-08-08

**Status:** findings pending contract definition. **Do not implement from this document.**
Each ORPHAN needs an ADR-defined contract plus producing task(s) first (the ADR-0027
pattern); consuming tasks must not re-derive or work around these. Definitions happen at
(or just before) the consuming milestone — not all at once.

**Method:** every interface consumed by plans 08/09 (plus spot-checks of 05/07) was traced
to a producing task in plans 02–07/10, an existing route/event on `main`, or an ADR.
~105 interfaces traced; **66 verified owned/implemented** (not listed); 17 orphans and
6 uncertain below. Excluded as already resolved/owned: ADR-0027 conversation contract,
WEB-4 Slice B (ADR-0021 → AR-13), WEB-4 Slice C (INT-1/INT-2).

## Orphans (no producer anywhere)

| # | Consumer | Interface consumed | Notes | Suggested owner |
|---|---|---|---|---|
| 1 | WEB-11 (M2) `08:154` | Workspace files API (file tree + content read) for browsers | Only internal/service-token producers exist (WS-3 agent routes, WS-4 `/internal/*`). **Conflicts with PRD §32.3 "raw fs/command APIs are not exposed"** — needs an owner-approved ADR before any task. | 02 + ADR |
| 2 | WEB-11 (M2) `08:154` | User-attributed direct-edit endpoint ("manual edit via web" commit) | Phrase exists only in plan 08; `write_file` is a model-attributed AR-4 tool. Same §32.3 conflict as #1. | 02 + 03 + ADR |
| 3 | WEB-11/WEB-9 (M2) `08:154,136` | Public commit-diff API (before/after any commit; PRD §14.3) | Runtime `git(diff/show)` is internal; AR-13 returns diffstats only, no patch content. | 06 or 02 |
| 4 | WEB-11/WEB-7 (M2) `08:154,118` | Public dev-server log read + restart (WS-13 log API passthrough; boot log tail) | WS-13 routes are agent/internal only; no `/v1` log or restart route. | 02 (extend CP-9) |
| 5 | WEB-11/WEB-13 (M2/M3) `08:154,172` | Public artifact fetch (screenshots, captures, Playwright trace → signed URL) | CP-20's signed-URL read covers user attachments only; nothing serves `art_` ids to browsers. | 02 (generalize CP-20 read) |
| 6 | WEB-9 (M2) `08:136` | Run controls "Retry failed task" + "Skip optional phase" | AR-10/PRD §32.2 define exactly pause/resume/cancel/redirect. | 04 + 02 |
| 7 | WEB-10 (M2) `08:145` | Interview contract: question event payloads + structured-answer submission | No `question.*`/`interview.*` event type; AR-16 defines policy, no contract. Same defect class as ADR-0027, one card over. | 02 + 04 (ADR sibling) |
| 8 | WEB-8 (M2) `08:127` | Preview screenshot capture (auto-captured attachment) | `POST /__zapp/screenshot` → 501 on `forge-node-base`; preview workspaces never get `forge-web-test` (confirmed in `provider/modal.ts`). Also field drift: WS-10 emits `computedRole`, WEB-8 spec says `role`. | 03 |
| 9 | WEB-17 (M2) + **M1 exit** `08:198`, `00:176` | Template repos in internal Git (`repoRef`), CP-6 template source behavior, pre-deployed `demoUrl`s | Nothing seeds template repos; CP-6 takes no template identifier (confirmed on disk). **Breaks the M1 exit criterion "project created from template" — most urgent item in this audit.** | 06 + 02 (+07 for demos) |
| 10 | WEB-13/WEB-15 (M3/M4) `08:172,190` | `GET /v1/projects/:id/releases` (release list) | PRD §32.4 and on-disk `releases.ts` have create + by-id only; no list → no history, no rollback picker. | 07 + 02 |
| 11 | WEB-13/WEB-15 (M3/M4) `08:172,190` | Deployments/health read model (deploy history, active-in-prod, synthetic-check history) | DEP-7/DEP-11 compute + store; no route anywhere. | 07 + 02 |
| 12 | WEB-14 (M3–M4) `08:181` | Readiness fetch route (DEP-2 three-state + findings); "Retry stage-safe" action | `getReadiness()` is a port method, not a route; retry action named only in plan 08. | 07 + 02 |
| 13 | WEB-16 (M5) `08:207` | Public usage/credits read (balance, burn-down aggregates) | OPS-1B/OPS-3 are in-process/internal only. WEB-3's CreditsPill already leaks this gap (env-config placeholder). | 10 + 02 |
| 14 | WEB-12 (M3) `08:163` | Project archive state + public delete route | "Archive" exists only in plan 08; CP-17 is the internal pipeline, no route; no archive state anywhere. | 02 |
| 15 | MAC-11/MAC-8 (M4/M5) `09:163,188` | Org/project-scoped event feed or push (approvals badge, run/deploy notifications) | CP-15 is per-run only; OPS-7 and MAC-11 each name the other as producer. | 02 or 10 |
| 16 | MAC-9 (M4) `09:172` | User-session-scoped Git credential mint (desktop pull/push) | GIT-3 tokens are service-token-authenticated only. | 06 + 02 |
| 17 | DEP-4 (M4) `07:9,91` | Container image build capability in sandbox (`docker buildx`) | `forge-node-base` has no docker/buildkit; gVisor containment (ADR-0007) makes this non-trivial. | 03 |

## Uncertain (needs a decision, may not need new tasks)

| # | Consumer | Question |
|---|---|---|
| 18 | WEB-7 (M2) `08:118` | Console/network capture relay: `/__zapp/events` exists (WS-10) but the named relay "via preview status events" has no producer — mechanism text vs reality. |
| 19 | WEB-8 (M2) `08:127` | Element-selection payloads as structured message context: CP-20's `{content, attachments}` has no structured-context field; inlining selector JSON in prose would force text parsing (Constraint 11). Likely a small ADR-0027 amendment. |
| 20 | WEB-11 (M2) `08:154` | Per-test-case detail (status/duration): possibly an AR-13 sub-resource extension rather than a new route. |
| 21 | DEP-8 (M4) `07:125` | Grafana release annotations target "the project's dashboards" — OPS-9 deferred post-P0 (ADR-0022), OPS-10 provisions Faro apps not dashboards. Retarget or defer the annotation surface. |
| 22 | DEP-11 (M4) `07:151` | "Incident event + notification" — no `incident.*` event type; OPS-7/OPS-11 are M5, one milestone behind the consumer. |
| 23 | VF-16 (M3) `05:224` | Consumes INT-6/INT-7 isolated-DB validation (M4 producers) — milestone inversion; tracker note or resequence. |

## Disposition

- **Now (M1):** #9 template seeding — blocks the M1 exit checklist.
- **Before M2 starts:** #1–8, #18–20 (the WEB-9/10/11 cluster; #1/#2 need an owner call on
  PRD §32.3).
- **At M3/M4 entry:** #10–12, #16–17, #21–23.
- **At M5 entry:** #13–15.
