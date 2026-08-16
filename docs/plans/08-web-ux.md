# Plan 08 — Web App & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The browser client: Emergent-modeled home + conversational builder with live preview, Mission Control, deploy flow, and all PRD §20.1 surfaces — one continuous conversation from idea to production (PRD §10.0, §26A).

**UX benchmark:** `https://app.emergent.sh/home` (screenshot analyzed 2026-08-03) + Emergent first-app/deployment guides referenced in PRD §45. We mirror the interaction model and layout patterns, with zapp branding/copy — never verbatim Emergent copy.

**Architecture:** `apps/web` Next.js 15 App Router; RSC for dashboard/settings, client components for builder; state = TanStack Query + `subscribeRunEvents` SSE hook (api-client, CP-16) reducing structured events into UI state (Global Constraint 11: no chat-text parsing); `packages/ui` design system consumable by both Next (web) and Vite (desktop renderer).

**Tech Stack:** Next.js 15, React 19, Tailwind CSS v4, shadcn/ui-derived components in `packages/ui`, CodeMirror 6 (read/edit code view), xterm.js (logs/terminal view), TanStack Query v5, Storybook 8 (ui package), Playwright (web e2e).

**Milestone:** WEB-1..6 (M1), WEB-7..11 + WEB-17 (M2), WEB-12..16 (M3–M5 alongside backend availability). **Depends on:** Plans 02 (API/SSE), 04 (events), 05 (evidence), 07 (deploy contracts). **Consumed by:** Plan 09 reuses `packages/ui` + screens patterns.

## Global Constraints

Master plan §Global Constraints, plus:
- Every run-state element renders from `AgentEvent`s / read models — a UI feature that would require parsing assistant prose is a design bug; push it back to an event type.
- Progressive disclosure: happy path never *requires* opening code, terminal, Git, or raw logs (PRD §10.0.3); all of them remain one click away.
- Preview and production are visually distinct at all times (environment badge system).
- Every failure state offers: Fix automatically | Inspect details | Retry | Ask the agent (PRD §10.0.3).
- Accessibility (PRD §36.4): full keyboard nav on core flows, Mission Control states screen-reader announced (`aria-live=polite` for phase changes), color never sole status signal (icons + text), evidence images carry text descriptions.

## Design system (binding tokens — packages/ui)

- **Type:** Geist Sans (UI), Geist Mono (code). Scale: 32/24/18/16/14/12.
- **Radii:** cards `rounded-2xl` (16px), inputs/chips `rounded-full`, panels `rounded-xl`.
- **Light surfaces:** neutral `zinc` ramp; hero gradient token `--zapp-hero: linear-gradient(180deg, #7cb8e8 0%, #b7d9f2 45%, #eef6fc 100%)` (sky, per benchmark); accent `--zapp-accent: #2563eb`; status: success `#16a34a`, warning `#d97706`, danger `#dc2626`, info `#0891b2` — each paired with icon + label.
- **Env badges:** Preview = outlined cyan pill "Preview"; Production = solid slate pill "Production".
- **Support-level badges:** Compatible (gray), Verified (blue, shield-check icon), Managed (green, shield-check+gear) — used on projects/releases everywhere.
- Dark mode: P1 (post-P0); tokens structured for it now (semantic CSS vars only, no raw hex in components).

## Route map (App Router)

```text
/login, /auth/callback
/                       → home (prompt-first, Emergent-modeled)
/projects               → dashboard grid
/projects/:id           → builder (conversation ⟷ surface) [core screen]
/projects/:id/releases, /projects/:id/releases/:relId
/projects/:id/settings/{general,secrets,integrations,domains,members,danger}
/org/{usage,billing,audit,settings}
/invite/:token
```

---

### Task WEB-1: App scaffold + auth + org context

**Files:** Create: `apps/web/*` scaffold, `src/lib/api.ts` (api-client init), `src/lib/session.ts`, middleware
**Effort:** M

- [x] Binding behavior: cookie-session auth against CP-2 (login redirects to the Stytch B2B Discovery flow); org context = `x-organization-id` header from selected org (persisted per user, localStorage + URL override); unauthenticated → /login; e2e: login fake-port flow in CI (Stytch mocked at api layer via test-only auth port).
- [x] Commit: `feat(web): next scaffold with session + org context`

### Task WEB-2: `packages/ui` design system

**Files:** Create: `packages/ui/src/{tokens.css,components/*}`, Storybook, dual-bundler proof `apps/web` + a Vite smoke app in `packages/ui/examples/vite`
**Effort:** L

- [x] Binding behavior: components (each with story + a11y test via storybook axe): `Button, IconButton, Chip, Tabs, Card, StatusPill, EnvBadge, SupportLevelBadge, Drawer, Dialog, Tooltip, Avatar, CreditsPill, ProgressBar, Spinner, Timeline, TimelineStage, EmptyState, ErrorState(actions), Kbd, CodeBlock, Markdown, Toast`. Token CSS vars per Design system section; **Vite smoke build must pass in CI** (desktop reuse risk, master risk table).
- [x] Commit: `feat(ui): design system tokens + core components (Next+Vite)`

### Task WEB-3: Home screen (Emergent-modeled)

**Files:** Create: `src/app/(home)/page.tsx`, `src/components/home/{Hero,PromptComposer,SuggestionChips}.tsx`, `src/lib/{feature-flags,prompt-handoff}.ts`, e2e `e2e/home.spec.ts`; Modify: `src/components/session-home.tsx`, `src/components/builder/Shell.tsx`, e2e fixture server, web package manifest/lockfile, `.env.example`; review-driven API projection: auth profile route/store/tests, generated SDK artifacts, ADR-0009
**Effort:** M

Layout spec (mirrors benchmark screenshot, zapp copy):
- Full-bleed hero: `--zapp-hero` sky gradient, top bar overlay: left `Home` pill (grid icon), right `CreditsPill` (remaining credits, click → /org/usage) + `Avatar` menu (orgs, settings, sign out).
- Centered H1 (32px, white): **"Start with one prompt. We'll take it to production."** (copy config-driven; structural parity with benchmark's "Start with one prompt. You can change everything later.").
- Tabs card: `Web App` (active) | `Mobile App` (behind PostHog flag `mobile-app-tab`; while off, disabled with tooltip "Coming after P0"). Per accepted ADR-0009, the enabled choice is sent as public `appType`; neither tab may report a choice that the generated SDK cannot carry.
- Prompt card (`rounded-2xl`, white, shadow): textarea placeholder *"Describe your idea. zapp will build, test, and ship it."*, autosize 3→10 rows; bottom-left `+` opens a menu exactly matching the benchmark screenshot: **Upload file** (files/images), **Import from GitHub** (→ WEB-4 import flow), **Auto ▸** (mode & model selector submenu: "Auto (recommended)" default; modes Ask / Prototype / Build / Fix / Autonomous with one-line descriptions; model picker within org model policy), **Advanced controls** (run budget cap, target branch); bottom-right: mic button (behind PostHog feature flag `voice-input`, default off — OPS-6 catalog) + circular submit arrow (disabled until ≥ 10 chars). Selected mode/model chips render above the composer when non-Auto. Per accepted ADR-0009, an explicit model is sent as public `model`; Auto omits it and delegates routing to policy.
- Below: "Not sure where to start? Try these ⇄" shuffle + 3 `Chip`s with colored-dot icons, rotating from a 9-item config list (e.g. "Client portal for an agency", "Class scheduler for a yoga studio", "SaaS dashboard with Stripe billing"). Click → fills composer (not auto-submit).
- Bottom-right support bubble (links to docs/support mail P0).
- Submit → `POST /v1/projects` (name auto-derived) + `POST /v1/projects/:id/runs` (mode: recommended per prompt heuristic — Prototype for exploratory wording, Build otherwise; `appType` from the product tab; optional policy-approved `model`; user can change mode in builder) → route `/projects/:id` with composer text as first message.

- [x] Failing e2e: renders hero + tabs + chips; typing < 10 chars keeps submit disabled; chip click fills composer; submit navigates to builder with first message visible; keyboard-only path works (tab order: tabs → composer → attach → submit → chips).
- [x] Commit: `feat(web): prompt-first home screen`

### Task WEB-4: Projects dashboard + org switcher + new/import

**Files:** Create: `src/app/projects/page.tsx`, `src/components/projects/ProjectCard.tsx`, `src/components/projects/GitHubImportDialog.tsx`, `e2e/projects.spec.ts`, `docs/adr/0021-phased-web-4-without-inferred-state.md`; Modify: `src/components/projects/ProjectsDashboard.tsx`, `src/components/projects/NewProjectDialog.tsx`, `src/components/projects/projects.module.css`, `src/components/home/PromptComposer.tsx`, `src/lib/api.ts` (generated-SDK wrapper only), `e2e/support/server.ts` only for fixture capabilities used without route interception, this WEB-4 task/log in `docs/plans/08-web-ux.md`, `tasks/todo.md`
**Effort:** M

**Interfaces consumed:** only generated CP-21, INT-1, and INT-2 operations through `createControlPlaneClient`; race-safe summary batches share the existing request generation and abort lifecycle; GitHub import flows `installation -> repositories -> branches -> create project -> enqueue import -> poll -> route`; visible retries preserve exact project-create/import operation keys.

Phased delivery is governed by accepted ADR-0021. The task and tracker remain unchecked until all three slices are complete; an independently green base slice is not task completion.

- [x] **Slice A — API-backed base dashboard:** `/projects`; organization switcher populated from active `/v1/me` memberships and persisted with the WEB-1 per-user selection; keyset-paginated `GET /v1/projects` infinite grid; cards show **name, support-level badge, and Open only**; truthful empty state; `New project` opens a dialog reusing WEB-3's prompt composer/public create-project + create-run flow. Switching organization resets accumulated items/cursor, aborts prior list work, advances a request generation, removes a stale `organizationId` URL override via Next router replacement while preserving unrelated query parameters, and announces loading as a polite status. Initial and pagination responses may mutate state only for their captured current generation. Per ADR-0021, base membership/project read failures expose only a real **Retry**; Fix automatically, Inspect details, and Ask the agent stay absent until distinct public capabilities/context exist. Do not render or infer last activity, status dots, preview/production state, readiness, deploy, or GitHub state.
- [x] **Slice A e2e:** two-org user switches organizations → different project lists and each list request carries the selected `x-organization-id`; an Alpha→Beta→Alpha race proves stale pagination cannot append or advance/skip the fresh cursor; URL replacement preserves unrelated query parameters/history semantics and refresh uses the persisted selection; opaque `nextCursor` loads the next page once without duplicates; switch loading is announced via `role=status`; a failed list exposes a working Retry only; empty organization renders the empty state; New project opens the reused WEB-3 composer.
- [x] **Slice B — consumes CP-21:** batch each loaded base page through generated `GET /v1/projects/summaries`; add real last activity or `No activity yet`, Preview/Production icon-plus-text labels, and Deploy only when `deployReadiness.state === 'ready'`. Abort summaries on organization change, reject stale request generations, preserve base cards on summary error, and expose summary-specific Retry. No fixture-only or browser-inferred summary state.
- [x] **Slice C — consumes generated INT-1/INT-2 operations:** `Import from GitHub` performs installation, repository pagination, branch selection, confirm-time `sourceType: github_import` project creation, keyed enqueue, and abortable one-second status polling through `submitting|queued|mirroring|scan_pending|scan_accepted|failed`; navigate only at `scan_accepted`. Selection/organization changes create or reset operation identities, and failed retry retains the same keys. No fixture-only GitHub state or UI-private route.
- [x] Commit: `feat(web): dashboard with org switcher + github import entry`

#### WEB-4-FIX-1 — cold-run durable import retry acceptance bound

**Files:** Modify: `e2e/projects.spec.ts`, `tasks/todo.md`, this plan.

- [x] **RED:** exact-head GitHub CI proves the durable retry test can exceed its four-second observer deadline while waiting for two intentional one-second status polls; the product remains on `/projects` when the assertion expires.
- [x] **GREEN:** preserve the one-second product polling cadence and the two-poll fixture, but give the navigation observer eight seconds of cold-run scheduling slack.
- [x] **Verify/ship:** run the focused retry test repeatedly, web lint/typecheck, `pnpm verify`, commit `test(web): stabilize durable import retry polling`, push `main`, and confirm exact-head GitHub CI/Security green.

### Task WEB-5: Builder shell layout

**Files:** Create: `src/app/projects/[id]/page.tsx`, `src/components/builder/{Shell,TopBar,SurfaceTabs}.tsx`
**Effort:** M

Layout (PRD §10.0.2): top bar: project name, actions right: `Preview` (focus preview tab), `GitHub` (sync state pill: synced/ahead/diverged), `Deploy` (primary, enabled once a preview exists), Mission Control toggle, settings gear. Project support level remains available on the dashboard and API, but is omitted from the builder header because it is not an actionable editing state. Split: left conversation pane (min 380px, 40%), right surface (60%) tabs `Preview | Code | Logs | Tests`; Mission Control = right-side `Drawer` (overlay ≥ 1280px pushes content), collapsible, state persisted; responsive: < 1024px stacks with bottom tab switcher (conversation default).

- [x] e2e: pane resize persists; deploy disabled pre-preview with tooltip; Mission Control opens without navigation (URL unchanged, PRD §14.1).
- [x] Commit: `feat(web): builder two-pane shell with mission control drawer`

### Task WEB-6: Conversation stream (M1 subset)

**Files:** Create: `src/components/conversation/{Thread,Composer,MessageBubble,ToolActivityLine,ProgressCard}.tsx`, `src/hooks/useRunEvents.ts`
**Effort:** L

- [x] Binding behavior: `useRunEvents(runId)` = SSE subscribe (resume via last sequence from cache) reducing events → thread items: assistant text (`Markdown`), concise activity lines from `tool.started/completed` **userSummary strings** (grouped: "Edited 3 files · Ran build ✓" collapsible to detail), `ProgressCard` for `phase.*` events (phase name, step dots, elapsed), commit chips (`commit.created` → sha7 + message, click → Code tab diff); composer: send message (continues run or starts new one per mode), Stop button during active run (cancel signal), attach: image paste/upload, and the same `+` menu as WEB-3 (Upload file / Import from GitHub / Auto ▸ mode-model selector / Advanced controls) with the selection persisted per project; reconnect banner on SSE drop with silent catch-up (no duplicates — sequence dedupe test).
- [x] e2e with seeded event fixture stream: renders text, activity groups, progress card; kill SSE → reconnect → no dupes; Stop fires cancel and UI reflects `run.cancelled` ≤ 5 s.
- [x] Commit: `feat(web): event-sourced conversation thread`

#### WEB-6-FIX-1 — concise collapsed conversation activity rollups

**Root cause:** `Thread` flushed its activity accumulator for non-rendered lifecycle metadata such as `tool.output`, `agent.started`, and `usage.recorded`, while `ToolActivityLine` joined every completed `userSummary` verbatim. Normal project setup therefore rendered separate start/completion rows and long filename lists instead of one reader-friendly progress update.

**Files:** Modify `apps/web/src/components/conversation/{Thread,ToolActivityLine}.tsx`, `apps/web/test/conversation-presentation.test.ts`, `apps/web/e2e/conversation.spec.ts`, this plan, and `tasks/todo.md`. Add the approved design and implementation plan. No public API, event schema, orchestration, preview, sandbox, model-gateway, or port behavior is in scope.

- [x] Build semantic summaries from structured tool names, lifecycle outcomes, and audit
  counts/path metadata; keep failed `userSummary` text prominent and active work visible.
- [x] Preserve exact ordered lifecycle summaries behind a native, closed-by-default `Details` disclosure.
- [x] Ignore non-rendered events as activity boundaries while retaining messages, cards, phases, commits, and run changes as meaningful boundaries.
- [x] Prove the rendering with focused SSR tests and a seeded browser stream containing `tool.output` and agent metadata. Commit: `fix(web): collapse conversation tool activity`.

### Task WEB-7 [M2]: Preview panel

**Files:** Create: `src/components/preview/{PreviewFrame,PreviewToolbar,ConsoleDrawer}.tsx`
**Depends on:** CP-21 / ADR-0028 public logs, restart, capture SSE, and screenshot SDK operations.
**Effort:** L

- [x] Binding behavior: iframe on the same-origin zapp authenticated preview URL (WS-12/ADR-0023; no Modal URL or provider token reaches the client); toolbar matches the benchmark pattern: centered device-size toggles (desktop/tablet/mobile widths), top-right open-in-new-tab + refresh, URL path bar (route-change events update it), share (WS-12 share records UI), env badge "Preview"; states (PRD §26A.1): starting (skeleton + boot log tail), sleeping (wake CTA → workspace start), stale (banner "Preview is behind latest changes — Restart"), disconnected (retry), failed (ErrorState with actions incl. "Fix automatically" → Fix run with boot log attached); console/network drawer fed by proxy capture events (`/__zapp/events` relayed via preview status events): error rows carry "Attach to chat" button.
- [x] e2e (fixture proxy): state transitions render; console error attaches to composer as structured attachment.
- [x] Commit: `feat(web): live preview panel with states + capture drawer`

#### WEB-7-FIX-1 — bounded preview lifecycle closure

**Files:** Modify: `src/components/preview/{PreviewFrame,ConsoleDrawer}.tsx`, `src/components/builder/{Shell,SurfaceTabs}.tsx`, `src/components/conversation/{Thread,Composer}.tsx`, `src/lib/api.ts`, `e2e/preview-panel.spec.ts`, `packages/ui/src/components/overlays.tsx`, and API-client exports required by those files.

- [x] **RED/evidence:** retain WEB-7 final review's correctness findings and extend the fixture test for in-page org-share renewal, live failed-state boot-log capture, and explicit composer-capacity rejection.
- [x] **GREEN:** renew authenticated shares before expiry; keep screenshot keys until the response body is consumed; abort/fence stale workspace reads and mutation completions while clearing workspace-scoped keys; refresh the last log cursor on failure; and acknowledge composer acceptance before reporting a capture as attached.
- [x] **Verify/review/ship:** run focused and full web gates plus API-client gates; run at most two fresh Critical/Important review rounds (exit zero); then close WEB-7 and WEB-7-FIX-1 together with no provider call.

#### WEB-7-FIX-2 — structured Fix evidence after AR-19 lands

**Files:** Modify: `src/components/preview/PreviewFrame.tsx`, `src/components/builder/{Shell,SurfaceTabs}.tsx`, `e2e/preview-panel.spec.ts`

- [x] **RED/evidence:** reproduce the clean-checkout type failure after AR-19 makes `fixRequest` mandatory, then assert the fixture sends the captured artifact, implicated commit, reproduction reference, and retry-stable body.
- [x] **GREEN:** capture and upload immutable preview evidence through the public SDK, derive the relevant commit from events with the public branch head as fallback, and submit the strict Fix request without repeating successful evidence writes on retry.
- [x] **Verify/review/ship:** run focused and full web gates plus API-client gates, complete at most two review rounds with zero Critical/Important findings, and confirm GitHub CI green; no provider call is required.
- [x] Commit: `fix(web): send structured evidence with preview Fix runs`

### Task WEB-8 [M2]: Element selection + rich attachments

**Files:** Create: `src/components/preview/SelectMode.tsx`, composer attachment chips
**Effort:** M

- [x] Binding behavior: "Select element" toolbar toggle → postMessage to zapp-client (WS-10) → hover outlines in iframe → click returns `{ selector, role, text, boundingBox, componentHint, screenshot }` → attachment chip in composer ("Selected: `<Button> 'Save'` on /settings"); attachments serialize into run message payload (AR consumes as structured context, PRD §10.0.1 step 6); screenshot attachments auto-captured for error attachments.
- [x] e2e: select → chip → sent message payload contains selector JSON (network assertion).
- [x] Commit: `feat(web): visual element attach for change requests`

### Task WEB-COLD-FIX-1 — isolate E2E Next build output

**Files:** Modify: `apps/web/e2e/support/server.ts`, `apps/web/package.json`; Create: `apps/web/e2e/support/next-dev-output.ts`, `apps/web/test/next-dev-output.test.ts`; Modify: `docs/plans/08-web-ux.md`, `tasks/todo.md`

- [x] **RED:** after `next build` leaves production output in `apps/web/.next`, the Playwright support server's `next dev` startup fails against that shared directory with missing build manifests/routes/chunks; retain the exact `pnpm --filter @zapp/web build && pnpm --filter @zapp/web test` failure evidence.
- [x] **GREEN:** before listening or spawning, remove only the web test app's deterministic absolute `.next` directory through the filesystem API; preserve signal cleanup and production startup behavior.
- [x] **Verify/review/ship:** the cleanup unit regression preserves siblings while removing the exact output tree; the exact build-to-88-E2E sequence plus web lint/typecheck/build and diff checks pass; run at most two fresh review rounds, exiting at zero Critical/Important findings; no provider call is required.
- [x] Commit: `fix(web): isolate e2e Next build output`

### Task WEB-COLD-FIX-2 — align the repository test contract with isolated E2E startup

**Files:** Modify: `packages/config/test/turbo.test.ts`, `docs/plans/08-web-ux.md`, `tasks/todo.md`

- [x] **RED:** `pnpm --filter @zapp/config test` rejects the WEB-COLD-FIX-1 test command because the cross-package manifest contract still expects bare `playwright test`.
- [x] **GREEN:** assert the shipped unit-regression-plus-Playwright command while retaining the no-shared-rebuild `test:e2e` contract.
- [x] **Verify/review/ship:** the config package suite and full pre-push gate pass; one focused review exits when the manifest contract matches the shipped command with no scope expansion; no provider call is required.
- [x] Commit: `test(config): align isolated web test contract`

### Task WEB-9 [M2]: Mission Control drawer

**Files:** Create: `src/components/mission-control/{Overview,TaskGraph,Agents,Activity,FilesCommits,Tests,Approvals,Risks}.tsx`
**Effort:** L

- [x] Binding behavior (PRD §14.2/§14.3): tabs: **Overview** (current phase, progress bar, live cost vs budget from `usage.recorded`, preview status), **Tasks** (dependency graph — dagre layout, nodes colored+iconed by state, click → task detail: AC, commits, evidence), **Agents** (active roles + current tool), **Activity** (recent tool calls list, user-language summaries, "raw detail" expander = optional per §14.1), **Files/Commits** (diffstat list → Code tab), **Tests** (runs, failures, screenshots), **Approvals** (open approval cards + history), **Risks** (risks_json from verifier); actions bar: Pause/Resume/Cancel (confirm)/Redirect (opens composer scoped "redirect" input), Retry failed task, Skip optional phase, Open preview, Compare commits (before/after → Code diff); all actions optimistic + reconciled by events; `aria-live` announcements on phase/task state changes.
- [x] e2e on fixture event stream: graph renders states; pause→paused pill ≤ 5 s; approval card resolve flows.
- [x] Commit: `feat(web): mission control drawer (views + actions)`

### Task WEB-10 [M2]: Interview, spec summary, plan approval cards

**Files:** Create: `src/components/conversation/{QuestionCard,SpecSummaryCard,PlanReviewCard,ApprovalCard}.tsx`
**Effort:** L

- [x] Binding behavior (PRD §10.0.1 steps 2–3, §12.3, §13.1): QuestionCard renders grouped compact form (radio/checkbox/short-text per question option payload) + free-text alternative — one submit returns structured answers; SpecSummaryCard: agent's understanding summary + expandable full spec (sectioned; inline edit per section → consequence note from agent before accept), actions: **Start building** (primary) / Keep discussing / Edit details; PlanReviewCard: phases accordion (tasks, AC count, risk chips, cost/effort estimate, approval points), actions Approve plan / Request changes; ApprovalCard (generic, drives AR-14/AR-20/deploy approvals): typed payload rendering (budget increase, plan diff (added/removed/modified lists), destructive migration with SQL preview) + Approve/Reject + reason.
- [x] e2e: scripted interview → answers submitted as structured payload; spec approve → `POST .../approve` called; plan diff card renders fixture diff.
- [x] Commit: `feat(web): interview + spec/plan approval cards`

### Task WEB-11 [M2]: Code, Logs, Tests surfaces

**Files:** Create: `src/components/code/{FileTree,CodeView,DiffView}.tsx`, `src/components/logs/LogView.tsx`, `src/components/tests/{TestRuns,EvidenceViewer}.tsx`
**Effort:** L

- [x] Binding behavior: **Code**: file tree (lazy via workspace files API), CodeMirror read view; edit mode for Owner/Builder (save = `write_file` through a user-attributed direct-edit endpoint creating its own commit "manual edit via web"); diff view for any commit (before/after, PRD §14.3 compare); **Logs**: dev-server + tool output streams (xterm.js, follow toggle, search) — reads WS-13 log API + tool.output events; **Tests**: `test_runs` list → cases with status/duration, evidence viewer: screenshots (with text description), console/network captures, Playwright trace download link; failed case → "Create Fix run" button (AR-19 entry).
- [x] e2e: open file renders content; commit diff renders; failed test fixture shows screenshot + fix CTA.
- [x] Commit: `feat(web): code/logs/tests surfaces`

### Task WEB-12 [M3]: Settings — secrets, integrations, members, GitHub

**Files:** Create: `src/app/projects/[id]/settings/*` pages
**Effort:** L

- [x] Binding behavior: Secrets: name+env scoped add (value write-only — after save shows metadata only, rotate = re-enter, PRD §22.2 "no read through UI"); Integrations: connect cards for GitHub/Supabase/Neon/Stripe/Vercel (status, connected account, disconnect) driving §32.5 routes; Members: org members with roles (Owner edits), invite flow, `builderCanDeploy` toggle (Owner); GitHub: sync policy picker (direct push / PR), sync state, manual sync now, export button; Danger: archive/delete with typed-name confirm (delete → CP-17 pipeline notice on timeline).
- [x] e2e: secret value never appears in any response after creation (network-level assertion); viewer sees no settings mutations.
- [x] Commit: `feat(web): project settings suite`

### Task WEB-13 [M3]: Releases + evidence viewer

**Files:** Create: `src/app/projects/[id]/releases/*`
**Effort:** M

- [x] Binding behavior: release list (status, commit, env, support badge, created by/at, active-in-prod marker); detail: evidence manifest rendered as the Appendix D report (sections with pass/fail/waiver chips + artifact links), criteria table (VF-9: every criterion with result — unverified/failed never hidden), rollback target, deploy history; actions: Deploy (if ready+approved role), Fork to repair branch (DEP-12).
- [x] e2e: fixture manifest renders all criteria incl. a failed one prominently.
- [x] Commit: `feat(web): release history + evidence report viewer`

### Task WEB-14 [M3–M4]: Deploy flow UI

**Files:** Create: `src/components/deploy/{ReadinessSheet,ConfirmDialog,StageTimeline,SuccessCard}.tsx`
**Effort:** L

- [x] Binding behavior (PRD §26A): Deploy click → ReadinessSheet: three-state header (**Ready to deploy** green / **Warnings found** amber / **Deployment blocked** red) + findings list with per-finding action buttons (Fix and recheck → Fix run; Review; Waive where allowed w/ reason) — copy exactly from DEP-2 payloads; continue → ConfirmDialog: deployment type headline (First deploy / Redeploy / Replace deployment) + DEP-3 confirmation payload verbatim (data/secrets/URL/user impact bullets; Replace requires explicit data-disposition radio before enabling confirm); deploying → StageTimeline (8 DEP-6 stages, live status/elapsed/summary, failure = inline evidence + actions Retry stage-safe / Fix automatically / Ask agent, previous release banner "Production unaffected"); success → SuccessCard per §26A.5 (URL copy, Add custom domain, release id/commit, evidence link, health status, monitoring links, Rollback to rel_… secondary, "future changes stay in preview until you redeploy" note).
- [x] e2e: blocked state disables continue; replace w/o disposition disabled; timeline renders failure without success state; success card fields from fixture payload.
- [x] Commit: `feat(web): readiness → confirm → staged deploy → success flow`

### Task WEB-15 [M4]: Observability + health + rollback UI

**Files:** Create: `src/app/projects/[id]/health/page.tsx` (or surface tab), rollback dialog
**Effort:** M

- [x] Binding behavior: production health card (health checks, error rate from Grafana link-through (Faro/Loki panels), web vitals summary from Faro where available, synthetic check history sparkline + last failures with "Create Fix run"); release annotations timeline; Rollback dialog: target release picker (previous healthy default) + DEP-9 `databaseState` rendering — `incompatible` blocks with explanation, `requires_compensation` shows plan requirement (never "rollback complete" implication for DB, PRD §27.5).
- [x] Commit: `feat(web): production health + guarded rollback UI`

### Task WEB-14-FIX-2 [M6]: Integrated unified-builder E1 proof

**Files:** Modify: `apps/web/src/components/builder/BuilderDeploy.tsx`, `apps/web/e2e/e1-journey.spec.ts`, `apps/web/e2e/support/{server,e1-composition}.ts`, `apps/web/e2e/*.spec.ts` fixture identifiers, `apps/web/package.json`, `pnpm-lock.yaml`, `services/control-api/src/{events/sse,routes/releases}.ts`, `services/control-api/test/{releases,integration/sse}.test.ts`, `tasks/{todo,lessons}.md`, `docs/plans/{00-master-plan,08-web-ux}.md`
**Effort:** M

- [x] Preserve the review RED: the browser journey stayed green while a preloaded orchestrator/release fake ignored approvals and iteration, and it bypassed the authenticated preview bootstrap with fulfilled HTML.
- [x] Run the production autonomous Temporal workflow in a local test server with only provider/persistence adapters, make interview and approval signals advance its durable state, and prove redirect changes the dependent task before final evidence is created.
- [x] Exercise the real Next preview bootstrap, public share-session exchange, signed preview credential redemption, and authorized proxy response; preserve upstream SSE headers across the public control-api stream.
- [x] Discover a candidate created after the builder mounts, show the real readiness policy result, approve through the generated public SDK, and execute the production deployment workflow through its eight stages.
- [x] Run the exact E1 browser journey, complementary autonomous and deployment workflow suites, control-api release/SSE checks, full serial web regression, lint, typecheck, and the second/final review round; at the two-round cap, re-scope its two release-state findings into exact lifecycle enforcement and focused browser regressions without starting a third review.
- [x] Commit: `test(web): prove integrated unified builder journey`

### Task WEB-17 [M2]: Template gallery + detail with live preview & Remix

**Files:** Create: `src/app/templates/{page,[slug]/page}.tsx`, `src/components/templates/*`
**Effort:** M

- [x] Binding behavior (benchmark screenshots 2–3; PRD §8.1 templates + community templates): consume CP-25's public template projection `{ slug, name, description, pagesIncluded[], highlights[] (e.g. "Auth pre-built", "AI included"), demoUrl (pre-deployed static demo), stack }`; GIT-6 keeps the internal `repoRef` server-side and it is never serialized to the browser. Gallery grid from home ("Try these" chips deep-link here too); detail view mirrors the benchmark layout: left info panel (name, description paragraph, "Pages included" chips, Highlights badges), right = live demo preview iframe (`demoUrl`) with the WEB-7 toolbar pattern (device toggles centered, open-in-new-tab + refresh top-right); primary action **"Remix this template"** → creates a project from the public template `slug`, whose approved source CP-25 resolves server-side, and opens the builder with a seeded first message ("I'm starting from the <name> template"); demo previews are pre-deployed once per template release (no live sandbox needed for browsing).
- [x] e2e: gallery renders registry; detail shows chips/highlights + iframe; Remix creates project and lands in builder.
- [x] Commit: `feat(web): template gallery + detail with demo preview and remix`

### Task WEB-16 [M5]: Usage/billing, audit log, a11y pass, activation instrumentation

**Files:** Create: `src/app/org/{usage,billing,audit}/page.tsx`; a11y fixes across app
**Effort:** L

- [x] Binding behavior: Usage: credits balance, burn-down by project/run/category (ledger aggregates), budget alerts config; Billing: plan card, seats, payment method (Stripe portal link), top-up credits (OPS-5 checkout); Audit: filterable table (Owner only); a11y: axe clean on home/dashboard/builder/deploy (CI gate), full keyboard e2e for prompt→preview→deploy path; activation analytics (PostHog via OPS-6): `signup, project_created, first_preview_ready, first_change_applied, plan_approved, first_deploy_succeeded` fired from event stream (client-side, org-scoped).
- [x] Commit: `feat(web): usage/billing/audit + accessibility gate + activation funnel`

### Task WEB-18 [M6]: Reference-quality real API product shell and builder Manage

**Design:** `docs/superpowers/specs/2026-08-13-real-api-ui-shell-design.md`
**Binding execution expansion:** `docs/superpowers/plans/2026-08-13-real-api-ui-shell.md`
**Files:** The exact Create/Modify/Test lists in Tasks 1 through 8 of the binding execution expansion. No desktop files are in scope.
**Effort:** XL, split into the eight independently verified commits prescribed by the execution expansion.

**Interfaces consumed:** Existing Stytch control-plane redirect/cookie session, `/v1/me`, project/project-summary/run/conversation/preview/file/code/log/test/release/health/settings/integration/billing APIs, generated `@zapp/api-client`, and structured `AgentEvent` SSE.

**Interfaces produced:** Optional `previewThumbnail` on `GET /v1/projects/summaries`; tenant-scoped `GET /v1/projects/:projectId/preview-thumbnail/:artifactId`; shared authenticated `AppShell`; typed shell/provider/builder navigation models; shared route/embedded `ProjectSettingsPanel`; builder `Preview | Manage` composition.

- [x] Task 1: Add the tenant-scoped project thumbnail projection, bytes route, generated SDK operation, and isolation coverage test-first.
- [x] Task 2: Add the responsive authenticated product shell and branded Stytch-backed login without changing identity transport.
- [x] Task 3: Compose the prompt dashboard with real recent projects and optional authenticated thumbnails.
- [x] Task 4: Restyle the full projects workspace while preserving pagination, organization races, and GitHub import identities.
- [x] Task 5: Extract settings into typed API-backed modules and render only GitHub, Supabase, Neon, Stripe, and Vercel.
- [x] Task 6: Add the builder Preview/Manage composition while preserving conversation, pane resizing, Mission Control, and deployment behavior.
- [x] Task 7: Apply the shell and page hierarchy to account, template, release, and health routes without changing their public contracts.
- [x] Task 8: Close two local review rounds, accessibility/responsive acceptance, the full local gate, one connected E1 run, and one credential-gated Stytch check.
- [x] Commit sequence and verification commands match the binding execution expansion; final closure commit: `feat(web): complete real API product shell`.

#### WEB-18-FIX-3 — immersive builder prompt and preview repair

**Design:** `docs/superpowers/specs/2026-08-13-immersive-builder-repair-design.md`
**Binding execution expansion:** `docs/superpowers/plans/2026-08-13-immersive-builder-repair.md`
**Files:** The exact Create/Modify lists in the binding execution expansion. No desktop files are in scope.

- [x] **Prompt feedback:** an API-accepted prompt is immediately visible with a truthful queued/running state before the first SSE event; the durable `message.user` event reconciles without duplication; failures retain the input and retry identity.
- [x] **Immersive layout:** the builder owns the full viewport, uses a compact header and bounded conversation column, preserves resizing/Mission Control/responsive panes, and removes the nested product-sidebar/mode-switcher hierarchy.
- [x] **Preview hierarchy:** the preview remains the dominant surface with one compact toolbar, a fill-height stage, and working route/device/open/refresh/share/select/console/error flows.
- [x] **Verify/review/ship:** focused and full web gates, accessibility/responsive browser acceptance, full-stack authenticated prompt-to-preview verification, repository verification, exact-head push, and green CI/Security.
- [x] Commit: `fix(web): repair immersive builder prompt and preview flow`

#### WEB-18-FIX-4 - compact reference editor chrome and balanced workspace

**Reference audit:** Live signed-in Lovable and Base44 editors plus the supplied screenshots.
**Files:** Modify builder/preview presentation components and their focused Playwright coverage. No API contract or desktop file changes are in scope.

- [x] Replace prominent text device controls with 23-28px icon controls that retain accessible names and titles.
- [x] Keep Preview as the visible primary surface while Files, Code, More, Preview/Manage, select, refresh, and open actions use compact icon chrome.
- [x] Rebalance the desktop conversation/workspace split to 44/56 by default while preserving pointer, keyboard, persistence, responsive panes, and Mission Control behavior.
- [x] Verify the focused preview acceptance, full builder shell suite, web lint/typecheck, and a signed-in browser interaction audit with no console errors.
- [x] Commit: `style(web): refine builder editor chrome`

#### WEB-18-FIX-5 - reliable local preview and reference workspace surfaces

**Reference audit:** Live signed-in Lovable editor, the supplied Preview/Files/Code/More screenshots, and a real local Docker prompt-to-preview run.
**Files:** Modify `apps/web/src/components/{builder,code,conversation,preview}/*`, focused web tests and package test script plus its exact config-package wiring assertion, `services/orchestrator-worker/src/runtime/run-worker.ts` and its runtime test, `services/control-api/src/routes/mission-control.ts` and its route test, `scripts/local/{config,supervisor}.mjs`, `scripts/local.test.mjs`, and `docs/dev-setup.md`. No desktop files are in scope.

**Interfaces consumed:** Existing run/conversation/preview/file/code/log/test/settings APIs, structured run SSE, sandbox workspace tools, Git service commit tool, and authenticated preview share/exchange/redeem proxy.

**Interfaces produced:** No new route. Mission Control now projects the existing public preview lifecycle contract; follow-up runs inherit the durable branch. WEB-18-FIX-6 supersedes this task's local UI hostname after the host-only auth cookie exposed the split-origin defect.

- [x] Filter generated/dependency/VCS paths before commit and in the code explorer so a successful generated build cannot overflow the event API or expose implementation noise.
- [x] Share one run-event stream across conversation and preview, start preview capture only after the authenticated share exists, and preserve the latest branch when starting a follow-up run.
- [x] Match the compact reference hierarchy for Preview, searchable Files/Code, and More navigation while keeping unavailable source-control/release capabilities truthful.
- [x] Project real `preview.starting|ready|failed` payloads in Mission Control and make the localhost preview origin complete share → exchange → redemption → proxied app delivery.
- [x] Verify focused TDD suites, full web acceptance, affected package lint/typecheck/tests, one real generated commit and preview, and the cold repository gate.
- [x] Commit: `fix(web): restore reliable local preview workspace`

#### WEB-18-FIX-6 - canonical local auth and browser origin

**Root cause:** The local Stytch callback and host-only session cookie use `127.0.0.1`, while `APP_BASE_URL`, CORS, readiness, and the launched UI use `localhost`. A signed-in request can pass server middleware on `127.0.0.1` and then stall when the browser's credentialed `/v1/me` request is rejected by exact-origin CORS.
**Files:** Modify `scripts/local/{config,supervisor}.mjs`, `scripts/local.test.mjs`, `services/control-api/src/routes/preview.ts`, `services/control-api/test/integration/redis.test.ts`, `docs/dev-setup.md`, this plan, and `tasks/todo.md`. No public API contract, cookie policy, or desktop file changes are in scope.

- [x] Add a failing local regression that requires the browser, API, and launched UI to use one canonical `127.0.0.1` hostname.
- [x] Pin `APP_BASE_URL`, readiness, browser launch, and setup documentation to `http://127.0.0.1:3000`.
- [x] Keep a redeemed Redis preview grant parseable so a browser refresh can replay the keyed exchange and reopen the iframe.
- [x] Restart the real `pnpm local` entry point and verify signed-in session bootstrap, exact-origin credentialed CORS, and the existing preview share/redemption flow.
- [x] Run focused local tests, affected lint/typecheck, the cold package/browser phase, and the complete pre-push repository gate.
- [x] Commit: `fix(local): unify authenticated loopback origin`

#### WEB-18-FIX-7 - real workspace tree and embedded preview authorization

**Root cause:** Directory listings below `.` return paths relative to the requested directory, but the web client merged those paths at the root and rendered a permanently flat list. Local embedded previews also used a `SameSite=Lax` cookie across the `127.0.0.1` to `*.preview.localhost` site boundary, so Chromium withheld the cookie from the iframe request and the proxy returned `preview_unauthorized`.
**Files:** Modify `apps/web/src/components/code/{CodeView,FileTree,code.module.css}`, `apps/web/src/lib/api.ts`, `apps/web/e2e/{conversation,preview-share}.spec.ts`, `services/control-api/src/routes/preview.ts`, `services/control-api/test/preview.test.ts`, this plan, and `tasks/todo.md`. No desktop files are in scope.

- [x] List only immediate workspace children, canonicalize nested paths against their requested directory, and render an expandable tree that opens the real canonical file path.
- [x] Issue the authenticated preview cookie for a cross-site embedded context using `SameSite=None; Partitioned` while retaining the host-only, secure, HttpOnly boundary.
- [x] Prove the browser sends the preview cookie on the final isolated-origin iframe request and that nested real project files expand, collapse, and open without root duplicates.
- [x] Run focused browser/API tests, affected lint/typecheck, a live local project check on port 3000, and the repository push gate.
- [x] Commit: `fix(web): restore project files and embedded preview`

#### WEB-18-FIX-8 - stable Vite HMR preview transport

**Root cause:** The control-plane preview bridge copied `Sec-WebSocket-Protocol: vite-hmr` into the upstream request headers but did not pass it through the `ws` client's protocol argument. Vite selected `vite-hmr`, the client rejected the handshake as unsolicited, and the embedded preview retried continuously, producing visible flicker.
**Files:** Modify `services/control-api/src/routes/preview.ts`, `services/control-api/test/preview.test.ts`, this plan, and `tasks/todo.md`. No UI redesign, desktop files, or public API contract changes are in scope.

- [x] Reproduce the real Vite-style WebSocket subprotocol handshake against a local socket server and retain the failing bridge error.
- [x] Negotiate sanitized incoming WebSocket subprotocols through the upstream `ws` client without duplicating the raw protocol header.
- [x] Run focused control-plane tests, affected lint/typecheck, verify the running local stack no longer emits the handshake error, and run the repository push gate.
- [x] Commit: `fix(preview): preserve Vite HMR WebSocket protocol`

#### WEB-18-FIX-9 - durable branch workspaces and truthful agent failures

**Root cause:** The builder trusted a run-scoped workspace after its provider workspace had expired, treated a sleeping dev server as a new start, and did not persist the pushed branch head. A terminal worker failure could also end without an assistant message. Finally, the polling Next dev watcher observed its own custom `.next-e2e-*` output, causing full reloads that made the editor and preview appear to flicker or hang.
**Files:** Modify `apps/web/{e2e,src,test,next.config.ts,package.json}`, `scripts/local/{config.mjs}`, `scripts/local.test.mjs`, `services/control-api/{src,test}`, `services/orchestrator-worker/{src,test}`, this plan, and `tasks/todo.md`. No desktop files are in scope.

- [x] Reject terminated and foreign-branch workspaces, recover from the real project branch through the public workspace API, and coalesce concurrent recovery, restart, and automatic wake requests.
- [x] Use the existing dev-server restart lifecycle for sleeping previews, retain one workspace across run-event changes, and bound authenticated-share retries so the iframe remains stable.
- [x] Persist the generated commit on the branch, default branchless follow-up runs to the active main branch, and emit a useful assistant explanation before failed or budget-exhausted terminal status.
- [x] Keep the code surface backed by the recovered workspace and exclude VCS, dependency, and generated Next output from the polling watcher.
- [x] Verify focused web/API/worker TDD suites, the complete browser suite, a live branch-backed Docker preview share/exchange/redeem chain, affected lint/typecheck, and the cold repository gate.

#### WEB-18-FIX-10 - durable local preview recovery and text-safe HMR

**Root cause:** Local Docker workspaces mounted only `/cache`, so terminating a provider container destroyed the branch checkout and every uncommitted generated file under `/workspace`. Run finalization also skipped `git push` when the model had already committed its work, leaving the database ahead of Forgejo. Finally, the control-plane WebSocket bridge discarded `ws`'s `isBinary` flag and forwarded Vite HMR text frames as binary Blobs, causing repeated JSON parse errors and visible preview reconnects.
**Files:** Modify `services/sandbox-service/src/provider/{docker,git-bootstrap}.ts`, `services/sandbox-service/test/{docker.test.ts,integration/git-clone.test.ts}`, `services/orchestrator-worker/src/runtime/run-worker.ts`, `services/orchestrator-worker/test/{run-runtime.test.ts,integration/ar9-postgres-worker.test.ts,integration/repair.test.ts,integration/verifier.test.ts}`, `services/control-api/src/routes/preview.ts`, `services/control-api/test/preview.test.ts`, `services/git-service/test/backup-cli.test.ts`, this plan, and `tasks/todo.md`. No UI redesign, desktop files, Modal behavior, or public API contract changes are in scope.

- [x] Mount each local project's durable volume at `/workspace`, reattach an existing matching branch checkout without resetting it, and retain local source across container replacement.
- [x] Push the resolved run head even when the worktree is already clean so a model-created commit reaches Forgejo before the database branch head advances.
- [x] Preserve text versus binary WebSocket frame semantics across both control-plane bridge directions so Vite receives JSON text rather than a Blob.
- [x] Prove a real TypeScript agent run, source-file API, embedded preview, container terminate/recreate, automatic Vite restart, affected suites, lint/typecheck, and the cold repository gate.
- [x] Commit: `fix(preview): preserve local workspaces across sleep`
- [x] Commit: `fix(web): recover durable previews and agent failures`

#### WEB-18-FIX-11 - stable local UI source resolution

**Root cause:** `verify:cold` is allowed to remove every package `dist` directory, but the running Next development server resolved `@zapp/ui` and its token stylesheet only through `packages/ui/dist`. Cleaning those build artifacts therefore turned an otherwise healthy local stack into a raw Next `Internal Server Error` until the UI package rebuilt.
**Files:** Modify `apps/web/next.config.ts`, `apps/web/test/next-config.test.ts`, this plan, and `tasks/todo.md`. No public API, UI redesign, package production export, desktop, or service behavior changes are in scope.

- [x] Add a failing Next configuration regression that requires local development to resolve the UI entry point and token stylesheet from source while preserving existing aliases.
- [x] Transpile the UI workspace package and map its development-only Webpack aliases to TypeScript/CSS source so local rendering is independent of disposable build artifacts.
- [x] Restart the real local supervisor, prove the app still responds while `packages/ui/dist` is absent, and run affected web lint/typecheck/tests.
- [x] Commit: `fix(web): keep local dev independent of package builds`

#### WEB-18-FIX-12 - dependency-safe preview startup

**Root cause:** the workspace execution contract requires an install command, but both dev-server start paths bypassed it and launched the development command immediately. Because dependency directories are intentionally absent from Git, every branch-restored workspace—and any new workspace whose earlier agent install failed—could reach `vite: not found` even while its source and contract were valid.
**Files:** Modify `services/sandbox-service/src/provider/modal.ts`, `services/sandbox-service/src/provider/docker.ts`, their focused and live Docker provider tests, `services/control-api/src/sandbox/client.ts`, `services/control-api/test/sandbox-preview-client.test.ts`, this plan, and `tasks/todo.md`. No immutable image rebuild, contract shape, network profile, generated application source, or UI redesign is in scope.

- [x] Add failing shared-provider coverage proving a fresh/restored workspace installs its contracted dependencies before starting the development command and reports install failures truthfully.
- [x] Make install success a serialized provider prerequisite for start/restart against both current immutable and future workspace-agent images, and bound it by the contracted install timeout.
- [x] Extend only the internal preview-start request deadlines through the control and sandbox provider layers so a legitimate fresh install is not aborted by the old 10/30-second transport limits.
- [x] Prove the focused provider/control suites, package lint/typecheck, and a real Docker workspace whose dependency directory is absent.
- [x] Commit: `fix(preview): install dependencies before dev startup`

#### WEB-18-FIX-13 - origin-rotation-safe workspace recovery

**Root cause:** durable local workspaces retained the correct project checkout and branch, but Git bootstrap compared the complete stored `origin` URL to the latest Git-service clone URL. Development tunnel rotation therefore rejected a valid same-project checkout at `find-origin`, hid its real source tree, and prevented preview recovery.
**Files:** Modify `services/sandbox-service/src/provider/git-bootstrap.ts`, `services/sandbox-service/test/integration/git-clone.test.ts`, this plan, and `tasks/todo.md`. No generated project files, branch reset, public API contract, immutable image, or UI redesign is in scope.

- [x] Add a failing durable-reattach regression proving a same-project origin hostname may rotate while uncommitted source remains intact, and a foreign project path remains rejected.
- [x] Validate the stored origin structurally against the scoped organization/project repository identity, then scrub it to the current credential-free clone URL.
- [x] Prove the focused Git bootstrap suite, sandbox lint/typecheck, and the affected real durable-volume recovery path.
- [x] Commit: `fix(preview): recover workspaces after origin rotation`

#### WEB-18-FIX-14 - verification-safe local web runtime

**Root cause:** the long-running `next dev` process and repository verification both used `apps/web/.next`. The web build starts by deleting that directory, so a valid cold/pre-push verification run removed live dev-server chunks and left port 3000 returning `Internal Server Error` until a manual restart.
**Files:** Modify `apps/web/next.config.ts`, `apps/web/test/next-config.test.ts`, `apps/web/tsconfig.json`, `apps/web/.gitignore`, `eslint.config.mjs`, this plan, and `tasks/todo.md`. No production build output, public API contract, generated project source, or UI redesign is in scope.

- [x] Add a failing configuration regression proving the default development output is isolated while explicit E2E and production output behavior remain intact.
- [x] Give local Next development a dedicated ignored output directory without changing the production build directory.
- [x] Prove the focused configuration suite, web lint/typecheck, and a live port-3000 request while a production build replaces `.next`.
- [x] Commit: `fix(web): isolate the live dev build cache`

#### WEB-18-FIX-15 - Lovable surface hierarchy and More navigation parity

**Root cause:** The compact builder shell still rendered its active More surface as an unlabeled icon, used the same placeholder diamond for every More navigation item, and flattened Cloud into a single logs screen. That removed the visual hierarchy and discoverability present in the approved Lovable references even though the underlying API-backed surfaces existed.
**Files:** Modify `apps/web/src/components/builder/{SurfaceTabs,MoreView,builder.module.css}.tsx/css`, `apps/web/e2e/builder-shell.spec.ts`, this plan, and `tasks/todo.md`. No public API, generated project source, preview lifecycle, desktop, or service behavior changes are in scope.

- [x] Add failing browser assertions that the active More tab has a visible label, the More navigation has distinct semantic icons instead of placeholder glyphs, and Cloud exposes Overview, Secrets, Logs, and Usage subviews.
- [x] Render compact SVG icons and a quiet nested Cloud navigation hierarchy while retaining the existing public API-backed logs/settings content and truthful empty states.
- [x] Verify the focused browser acceptance at desktop and mobile widths, web lint/typecheck, and the complete web suite.
- [x] Commit: `fix(web): match Lovable builder surface hierarchy`

#### WEB-18-FIX-16 - non-interactive development dependency recovery

**Root cause:** Preview startup now runs the execution contract's install command, but restored Docker workspaces can contain a dependency directory produced by a different pnpm environment. In that state pnpm asks permission to recreate `node_modules` and the headless install waits until its timeout. The workspace image also exports `NODE_ENV=production`, so an install that does complete omits Vite and other development dependencies required by the contracted development command. Both paths surface as `vite: not found` or an unavailable workspace even though the project source and contract are valid.
**Files:** Modify `services/sandbox-service/src/provider/modal.ts`, `services/sandbox-service/test/integration/modal-provider.test.ts`, this plan, and `tasks/todo.md`. No execution-contract shape, immutable image, generated project source, dependency version, public API, or UI redesign is in scope.

- [x] Add a failing shared-provider regression proving preview dependency installation is non-interactive and includes development dependencies for both start and restart.
- [x] Run preview installs with the minimum explicit environment needed to recreate stale dependency directories and install the development toolchain before launching the contracted command.
- [x] Prove the focused provider suite, sandbox lint/typecheck, and a real restored Docker workspace through the signed-in preview UI.
- [x] Commit: `fix(preview): restore development dependencies noninteractively`

#### WEB-18-FIX-17 - run-owned initial workspace provisioning

**Root cause:** The builder mounts Preview before Conversation finishes hydrating the latest run. With no run status or preview event yet, Preview treated a fresh project as an expired historical workspace and created a second sandbox. The UI recovery sandbox acquired the project-branch lock first, so Temporal's authoritative `ensureWorkspace` activity received a 502 and failed the run before dependency installation or agent work began.
**Files:** Modify `apps/web/src/components/preview/PreviewFrame.tsx`, `apps/web/e2e/preview-panel.spec.ts`, this plan, and `tasks/todo.md`. No public API, workspace lock, orchestration activity, dependency installation, generated project source, or visual redesign is in scope.

- [x] Add a failing browser regression proving Preview makes no workspace request while the latest active run is still hydrating and provisioning its workspace.
- [x] Allow automatic UI workspace creation only for completed historical runs or a structured preview event that already identifies the run-owned workspace, with truthful waiting and terminal empty states.
- [x] Prove the focused preview panel, web lint/typecheck, and signed-in fresh plus restored Docker project flows.
- [x] Commit: `fix(web): prevent fresh-run preview workspace races`

#### WEB-18-FIX-18 - source-aware preview wake and file recovery

**Root cause:** Restored workspaces could list hundreds of dependency and generated files before the bounded editor/source scan saw the project manifest and lockfile. The resulting stale npm execution contract launched a pnpm project without its cached development toolchain, while automatic and manual wake actions could race each other and repeat the install. This produced `vite: not found`, blank source trees, long wake failures, and sleeping previews that appeared not to wake.
**Files:** Modify `apps/web/src/components/preview/PreviewFrame.tsx`, `apps/web/e2e/preview-panel.spec.ts`, `packages/project-adapters/src/scan.ts`, `packages/project-adapters/test/integration/scan.test.ts`, `sandbox/workspace-agent/{package.json,src/exec.ts,src/fs.ts,test/agent.test.ts}`, `services/control-api/{src/routes/builder-preview.ts,test/builder-preview.test.ts}`, `services/sandbox-service/src/{provider/modal.ts,provider/volumes.ts,routes/workspaces.ts,workspace-files.ts}`, `services/sandbox-service/test/{integration/modal-provider.test.ts,workspace-files.test.ts}`, `pnpm-lock.yaml`, this plan, and `tasks/todo.md`. No public API shape, immutable image, generated application source, desktop file, or production provider substitution is in scope.

- [x] Add failing regressions for root-level recursive globs, source-first bounded file listings, current-source execution-contract refresh, package-cache propagation, and one guarded preview wake lifecycle.
- [x] Exclude dependency/generated trees structurally from editor and capability scans, derive preview startup from the current project source, and retain the shared package store through sandbox command execution.
- [x] Keep automatic and manual wake behind one in-flight guard, poll continuously from idle through ready/failed, preserve a healthy iframe when capture disconnects, and allow safe retries after concrete failures.
- [x] Prove the focused and full affected suites, package lint/typecheck, all 12 preview browser flows, the real source tree, and an authenticated Docker container-restart-to-render recovery.
- [x] Commit: `fix(preview): make workspace recovery reliable`

#### WEB-18-FIX-19 - isolate the live local web cache from browser-test output

**Root cause:** The canonical local supervisor inherited `ZAPP_WEB_NEXT_DIST_DIR` from its caller. After a focused Playwright run exported `.next-e2e-3100`, port 3000 and the browser-test server shared one Next.js output directory. Either process could then clean or rewrite the other's manifests, producing intermittent 500s, blank pages, preview flicker, unrelated test timeouts, and `require is not defined` errors.
**Files:** Modify `scripts/local/config.mjs`, `scripts/local.test.mjs`, this plan, and `tasks/todo.md`. No public API, generated application source, or test-server output ownership change is in scope.

- [x] Add a failing local-supervisor regression proving a caller-provided browser-test output directory cannot reach the port 3000 web process.
- [x] Pin the canonical local web process to its dedicated `.next-dev` directory at the structural environment boundary.
- [x] Prove the focused local supervisor suite, clean port 3000 startup, full web browser suite, and cold repository gate.
- [x] Commit: `fix(web): isolate local and browser-test build output`

#### WEB-18-FIX-20 - recover legacy and revisionless project previews

**Root cause:** The immutable development workspace image still uses the legacy recursive-glob matcher, which excludes root-level lockfiles for `**/*`. Recovery therefore refreshed a pnpm project into an npm execution contract and left wake stuck after dependency installation failed. Separately, a terminal run with no durable branch head has no workspace or revision to restore, but Preview still followed the workspace-wake path and left the user at a dead end.
**Files:** Modify `services/control-api/src/routes/builder-preview.ts`, `services/control-api/test/builder-preview.test.ts`, `apps/web/src/components/preview/PreviewFrame.tsx`, `apps/web/src/components/builder/{Shell.tsx,SurfaceTabs.tsx}`, `apps/web/e2e/preview-panel.spec.ts`, this plan, and `tasks/todo.md`. No workspace image rebuild, public API shape, generated application source, or visual redesign is in scope.

- [x] Add failing API and browser regressions for legacy-agent root lockfile discovery and terminal projects with no durable preview revision.
- [x] Make bounded capability scans compatible with the immutable legacy agent, refresh the real package-manager contract, and preserve the existing wake lifecycle.
- [x] Replace impossible revisionless wake recovery with a keyed public-API build retry in the same project branch and conversation.
- [x] Prove the affected API/browser suites, lint/typecheck, a live signed-in legacy Docker wake plus source tree, clean port 3000, and the cold repository gate.
- [x] Commit: `fix(preview): recover legacy and failed project previews`

### Task WEB-19 [M6]: Project conversation history and new threads

**ADR:** ADR-0034. **Files:** Modify builder thread/header/API/SSE composition and styles, add conversation hooks/history drawer, Playwright tests, this plan, and `tasks/todo.md` as enumerated by `docs/superpowers/plans/2026-08-16-durable-project-conversations.md`.
**Effort:** L. **[expand-at-execution]**

- [x] Render the selected conversation's structured events across every ordered run; terminal same-thread follow-up creates a successor without unmounting prior messages, while an active-run message uses the existing keyed continuation route.
- [x] Add accessible **History** and **New thread** controls. Store selection in `?conversation=`, support refresh/Back/Forward, select newest only when no selection exists, and create no empty record for `conversation=new`.
- [x] Show accepted busy-run user messages as **Queued** and transition only on the matching `message.applied`; merge history pages and active SSE by `(runId, sequence)` without duplicates or cross-tenant retained selection.
- [x] Prove seeded multi-run history, terminal follow-up, explicit new-thread creation, queued-to-applied state, pagination, navigation restoration, retry states, and organization fencing in focused and full web suites. Commit: `feat(web): add durable project conversation history`

#### WEB-19-FIX-1 - restore persisted preview lifecycle after conversation reload

**Root cause:** WEB-19 correctly merged persisted conversation events with the active run stream for the visible transcript, but forwarded only live SSE events to Preview. After reload, a terminal conversation has no live stream, so Preview lost the selected run's durable workspace and commit lifecycle and incorrectly rendered sleeping, unavailable, or revisionless recovery states.
**Files:** Modify `apps/web/src/components/conversation/Thread.tsx`, `apps/web/e2e/conversation.spec.ts`, this plan, and `tasks/todo.md`. No public API, preview recovery policy, workspace provider, generated project source, or visual redesign is in scope.

- [x] Add a failing browser regression proving a terminal run with persisted preview lifecycle events and an empty live stream recreates and restarts its project workspace after reload.
- [x] Forward the selected run's merged persisted and live events to Preview without leaking another run's lifecycle or reintroducing active-run workspace races.
- [x] Prove the focused regression, complete web browser suite, web lint/typecheck, and the restored local stack health.
- [x] Commit: `fix(preview): restore persisted conversation lifecycle`

### Task WEB-20 [M6]: Project-card deletion lifecycle

**Files:** Modify project dashboard/card/API/styles, add exact-name confirmation dialog, Playwright tests, this plan, and `tasks/todo.md` as enumerated by `docs/superpowers/plans/2026-08-16-project-card-deletion.md`.
**Effort:** M. **[expand-at-execution]**

- [x] Add an Owner-only accessible card overflow action for every project; Builders/Viewers never receive it, and exact project-name confirmation is mandatory.
- [x] Reuse CP-17's public keyed deletion request/status API, keep the key stable while outcome is unknown, and show truthful queued/running/failed/retry states until completion or a fresh scoped list omits the project.
- [x] Keep other cards usable, clean only the deleted project's thumbnail/state, and abort timers/requests plus clear stale state on organization changes.
- [x] Prove permission visibility, headers/idempotency, confirmation, bounded polling, retry-key rotation, multi-card isolation, and organization fencing in focused and full web suites. Commit: `feat(web): add project-card deletion`

### Task WEB-18-FIX-21 [M6]: Recover exited local preview workspaces

**Files:** Modify `apps/web/src/components/preview/PreviewFrame.tsx`, `apps/web/e2e/preview-panel.spec.ts`, `services/sandbox-service/src/provider/{docker,modal}.ts`, `services/sandbox-service/src/runtime.ts`, focused sandbox tests, this plan, and `tasks/todo.md`.
**Effort:** S.

- [x] Reproduce the boot-log failure from a durable ready attachment whose Docker container has exited.
- [x] Treat stopped Docker containers as unavailable for normal workspace lookup while retaining a cleanup-only termination path.
- [x] Reconcile stale provider resources before the durable attachment transition and let Preview recover or create the active branch after boot-log failure.
- [x] Prove stopped-container lookup, cleanup, background reconciliation, and browser recovery in focused tests, then pass affected package and complete repository gates. Commit: `fix(preview): recover exited local workspaces`

### Task WEB-21 [M6]: Lovable-parity tabbed code editor

**Files:** Modify the existing code surface, web dependencies, focused Node/Playwright tests, this plan, and `tasks/todo.md` as enumerated by `docs/superpowers/plans/2026-08-16-lovable-code-editor.md`.
**Effort:** M. **[expand-at-execution]**

- [x] Replace the plain source `<pre>` with the same CodeMirror 6 family verified in Lovable's live DOM, configured as a full-height read-only viewer with line numbers, syntax coloring, selection, and light active-line treatment for every role.
- [x] Add a compact Lovable-style semantic file explorer with search, expand/collapse-all, folder/file-type icons, lazy hierarchy, and a clear selected state.
- [x] Add ordered, deduplicated, closeable open-file tabs plus truthful reference-in-chat, copy-content, and download actions for the selected file; references render as removable composer chips and enter the next message context.
- [x] Prove API tenant headers, all-role read-only behavior, tab behavior, file actions, chat context handoff, syntax rendering, accessibility, full builder regression coverage, and visual parity. Commit: `feat(web): add Lovable-parity code editor`

### Task WEB-22 [M6]: Lovable-parity dashboard project creation

**Files:** Modify the authenticated home/dashboard route, prompt title derivation and composer styles, project creation entry points/cards, shell navigation, focused Node/Playwright tests, this plan, and `tasks/todo.md` as enumerated by `docs/superpowers/plans/2026-08-16-dashboard-project-creation-parity.md`.
**Effort:** M. **[expand-at-execution]**

- [x] Generate deterministic, meaningful project titles capped at three to four words while preserving the full first prompt for the run.
- [x] Make `/dashboard` the canonical project-creation surface and route every **New project** entry point there instead of opening a duplicate modal.
- [x] Remove non-actionable support-level badges from the project UI and match the approved prompt composer focus, padding, and action-row rhythm without weakening keyboard accessibility.
- [x] Prove title derivation, navigation, badge absence, composer focus/rhythm, and existing creation behavior in focused and full web suites. Commit: `feat(web): polish dashboard project creation`

### Task WEB-22-FIX-1 [M6]: Isolate E2E output per server run

**Files:** Modify `apps/web/.gitignore`, `apps/web/e2e/support/{next-dev-output,server}.ts`, `apps/web/test/next-dev-output.test.ts`, this plan, and `tasks/todo.md`.
**Effort:** S.

- [x] Reproduce the cleanup race where an exiting E2E server can delete a successor server's deterministic Next output directory.
- [x] Give every E2E server process a unique ignored Next output directory while retaining run-owned cleanup.
- [x] Prove same-port output names cannot collide, rerun the previously failing accessibility flow, and pass the complete repository gate. Commit: `fix(web): isolate e2e output per run`

---

## Testing strategy
- Storybook + axe per component; Playwright e2e per screen task against a **fixture-mode API** (seeded events/read models — no live agents needed for UI CI); one nightly staging e2e running the full prompt→preview→deploy happy path (ties to master E1).

## Scalability notes
- Event reducers are pure + memoized; thread virtualization (long runs = thousands of events) via windowing; SSE single connection per run shared through context.

## Security & tenancy notes
- No secret values ever render (write-only UI verified by e2e network assertions); org header injected centrally; support-visibility events never requested by user clients.

## Execution log

- 2026-08-16 WEB-6-FIX-1 done — Collapsed noisy tool lifecycle rows into structured reader-friendly activity batches with exact ordered details on demand; TDD reproduced seven rows before the fix and one after, 6/6 focused presentation tests and 24/24 conversation browser tests passed, web lint/typecheck and the production build passed, with the one pre-existing image warning unchanged.
- 2026-08-16 WEB-22-FIX-1 done — Replaced the shared per-port E2E Next output directory with a unique run-owned directory so delayed shutdown cleanup cannot corrupt a successor server; the focused regression, three repeated accessibility passes, 52/52 web Node tests, 163/163 browser tests, all integration/isolation suites, Gate 5, and the complete 94/94-task repository gate passed, while credential-dependent cases skipped visibly as designed.
- 2026-08-16 WEB-22 done — Added deterministic three-to-four-word project titles while preserving the full builder prompt, made `/dashboard` the canonical creation route, removed non-actionable support badges, matched the Lovable-style neutral composer rhythm, and passed 51/51 web Node tests, 163/163 browser tests, the production build, and the complete 94/94-task repository gate; credential-dependent integration cases skipped visibly as designed.
- 2026-08-16 WEB-18-FIX-21 done — Stopped Docker containers no longer masquerade as live workspaces, provider resources are cleaned before durable attachment reconciliation, and Preview recovers from boot-log failure through the current branch; 13/13 focused sandbox tests, the preview-disappearance browser regression, affected lint/typecheck, and the complete 94/94-task repository gate passed.
- 2026-08-16 WEB-21 done — Replaced the plain source view with a read-only CodeMirror 6 editor, Lovable-density tabs and darker compact semantic file icons, reference-in-chat context, polished conversation typography and localized timestamps, and removed the non-actionable builder Compatible badge; Builder/Viewer read-only checks, one-copy context handoff, 45/45 web Node tests, 160/160 browser tests, the production build, and the complete 94/94-task repository gate passed, while live-provider checks skipped visibly without credentials.
- 2026-08-16 WEB-19-FIX-1 done — Forwarded the selected run's merged durable and live events to Preview so terminal projects recover their workspace after reload; the TDD regression failed before and passed after, and the complete web and repository gates passed.
- 2026-08-16 WEB-20 done — Added Owner-only exact-name project-card deletion, truthful queued/running/unknown/failed states with automatic recovery reconciliation, bounded tenant-fenced polling, isolated cleanup, accessible disclosure behavior, and fresh-key failed-row restart support in the public API; passed 22/22 project browser tests, 7/7 deletion API tests, web/control API gates, and the full repository gate.
- 2026-08-16 WEB-19 done — Added tenant-scoped paginated project history, explicit new threads, same-thread successor continuity, queued/applied delivery state, safe ambiguous-admission handling, retryable history, legacy preview continuity, and passed 149/149 browser tests plus the full repository gate.
- 2026-08-16 WEB-18-FIX-20 done — Made capability scans compatible with the immutable legacy workspace agent, restored the actual pnpm preview contract, replaced impossible revisionless wake attempts with a keyed same-conversation build retry, passed control API 13/13 and web 140/140, rendered the real signed-in Docker preview and source tree, and passed the 94/94-task cold repository gate.
- 2026-08-16 WEB-18-FIX-19 done — Isolated the canonical port 3000 Next process in `.next-dev`, proved a clean local startup and the 140/140 browser suite, and passed the 94/94-task cold repository gate.
- 2026-08-15 WEB-18-FIX-18 done — Filtered dependency/generated trees before bounded listings and scans, refreshed preview contracts from current source, preserved the shared pnpm cache, serialized wake recovery, and proved 12/12 preview browser flows plus a live authenticated Docker restart that restored Vite and rendered the project.
- 2026-08-15 WEB-18-FIX-17 done — Reserved initial workspace provisioning for the authoritative run, restored terminal projects from their durable branch, and proved the focused preview lifecycle, web lint/typecheck, fresh-run non-race, and signed-in Docker restoration flow.
- 2026-08-15 WEB-18-FIX-16 done — Forced preview dependency recovery into non-interactive development mode for both start and restart; the focused and full sandbox suites, full repository gate, and signed-in restored Docker preview/source flow passed.
- 2026-08-15 WEB-18-FIX-15 done — Replaced placeholder More navigation with compact semantic icons, labeled the active surface, added Lovable-style nested Cloud navigation with truthful API-backed content, and passed 25/25 builder shell plus 136/136 browser tests, 37/37 web unit tests, lint/typecheck, desktop and 680px acceptance.
- 2026-08-15 WEB-18-FIX-14 done — Isolated long-running Next development in ignored `.next-dev` output while preserving explicit E2E directories and the production `.next` contract; the focused configuration suite passed 4/4, web lint passed with one pre-existing image warning, typecheck and production build passed, and eight concurrent plus one post-build port-3000 probes all returned HTTP 200 while `.next` was deleted and rebuilt.
- 2026-08-15 WEB-18-FIX-13 done — Confirmed the affected durable Docker volume still held its branch, source tree, dependencies, and uncommitted work but retained an obsolete development-tunnel Git origin; reattach now validates the scoped organization/project repository path independently of the rotating host, rejects foreign paths, and scrubs the origin to the current credential-free URL. The focused Git bootstrap suite passed 7 tests with 1 live-environment skip, sandbox lint/typecheck passed, and the full sandbox suite passed 210 tests with 19 provider-gated skips.
- 2026-08-15 WEB-18-FIX-12 done — Serialized the execution-contract install command before every Docker/Modal dev-server start and restart, extended only preview startup deadlines, rejected install failures before launch, and proved the current locked Docker image installs missing Vite and serves the generated document through the real preview proxy; sandbox 209 passed with 19 provider-gated skips, focused control 7/7, affected lint/typecheck, and the dependency-empty live Docker acceptance passed 1/1.
- 2026-08-15 WEB-18-FIX-11 done — Resolved `@zapp/ui` and its token stylesheet from source during Next development so cold verification cannot strand the live app after deleting package build output; the focused configuration regression passed 4/4, web lint/typecheck passed with one pre-existing image warning, and the real supervisor served the login page with `packages/ui/dist` absent.
- 2026-08-15 WEB-18-FIX-10 done — Preserved local branch workspaces on the per-project Docker volume, pushed clean model-created heads, retained Vite HMR text frames, and proved a real TypeScript build plus stop/recreate recovery with the same Forgejo SHA, 12 source files, 9/9 generated tests, a restored file API, and a zero-page-error embedded preview; affected suites, lint/typecheck, all 135 browser tests, missing-credential skips, isolation/GATE-5, and the 94/94-task cold repository gate passed.
- 2026-08-15 WEB-18-FIX-9 done — Recovered expired workspaces from their durable branch, automatically restarted sleeping previews without duplicate calls, persisted generated branch heads, made terminal agent failures explanatory, and stopped Next from watching its own output; focused API/worker suites and all 135 browser tests passed, with a live Docker preview returning the generated app through share, exchange, redemption, and proxy delivery.
- 2026-08-15 WEB-18-FIX-8 done — Preserved Vite's HMR WebSocket subprotocol through the control-to-sandbox bridge; the real socket regression passed, a live Docker workspace negotiated and held `vite-hmr`, all 134 browser tests passed, and the repository gate ran against the restored local stack.
- 2026-08-14 WEB-18-FIX-7 done — Restored canonical lazy workspace trees and CHIPS-compatible embedded preview sessions; focused API/browser coverage and all 134 web tests passed, while live Chromium rendered the generated app and opened the real `src/main.ts` from its active workspace.
- 2026-08-14 WEB-18-FIX-5 done — Restored source-only generated commits, single-stream run events, durable branch reuse, real preview lifecycle projection, canonical localhost redemption, and compact Lovable-style Preview/Files/Code/More; real Anthropic Docker run completed with 5/5 generated tests, source-only commit, preview ready, and share/exchange/redeem/document/source checks 201/200/200/200/200; web 134/134, runtime 15/15, Mission Control 5/5, local 14/14, config 84/84, orchestrator integration 45/45, lint/typecheck and cold repository gate passed.
- 2026-08-14 WEB-18-FIX-4 done - Matched the live Lovable/Base44 editor density with 23-28px icon controls, a 28px page selector, and a balanced 44/56 split; preview acceptance passed 1/1, builder shell passed 24/24, lint/typecheck passed, and signed-in browser interactions produced no console errors. A real prompt reached Temporal but Modal rejected provisioning with RESOURCE_EXHAUSTED because the provider workspace exceeded its spend limit, so a new live preview remains externally blocked until that limit is raised.
- 2026-08-14 WEB-18-FIX-3 done — Repaired the real prompt-to-workspace pipeline, authenticated preview transport, persistent sandbox/Git lifecycle, and compact immersive builder; verified a real Anthropic run plus preview share/redeem chain, live Stytch-to-Google redirect on port 3000, web 132/132, preview proxy 110/110, sandbox 194 passed with 18 provider-gated skips, and the complete cold repository gate including private Forgejo clone.
- 2026-08-13 WEB-4-FIX-1 done — Preserved the two one-second durable import polls while widening only the cold-run navigation observer; focused repeats passed 5/5, web lint/typecheck passed, and full repository verification including GATE-5 passed before the exact-head push gate.
- 2026-08-13 WEB-18-FIX-2 done - Added exact-`APP_BASE_URL`, credentialed CORS with the full public API method set so the real shell can call the control plane from the browser; the focused test passed 2/2, control-api lint/typecheck passed, PostgreSQL plus the live Stytch adapter passed 5/5, and localhost:3000 reached the real Stytch OAuth host; interactive Google completion remains unverified because both controlled browsers block `test.stytch.com` with `ERR_BLOCKED_BY_CLIENT` before Google renders.
- 2026-08-13 WEB-18 done - Shipped the reference-quality TypeScript product shell, real Stytch redirect login, API-backed dashboard/projects/settings/builder Manage/account/template/release/health flows, and tenant-scoped thumbnails; two visual/accessibility rounds closed, connected E1 passed, full web passed 126/126, the credentialed Stytch adapter gate passed 5/5, and `pnpm verify` passed 94/94 package tasks, 24/24 integration tasks, tenant isolation 55/55, with the disposable local test database moved to tmpfs after Docker Desktop fsync timeouts; Forgejo gate skipped because `FORGEJO_ADMIN_TOKEN` is unset.
- 2026-08-13 WEB-18-FIX-1 done - Hardened the cold gate after WEB-18: isolated each Next E2E output directory, made Playwright's single supervisor restore generated config on shutdown, removed stale production output before builds, excluded isolated generated output from lint, and bounded local DB hooks at 30 seconds; focused harness/config tests passed 10/10, web lint/typecheck passed, DB integration passed 52/52, and control API integration passed 310/310 with four credential-gated skips.
- 2026-08-13 WEB-14-FIX-2 done — Replaced the scripted E1 backend with the production autonomous Temporal workflow, real signal-driven interview/approval/redirect sequencing, actual preview bootstrap/session redemption, readiness policy, public release approval, and eight-stage deployment workflow; round-2 findings were re-scoped at the cap into exact candidate→verifying→ready/warnings→approved→deploying→healthy enforcement and ready/warnings builder discovery, with E1 1/1, focused browser 22/22, full serial web 111/111, autonomous 10/10, deploy 4/4, release routes 19/19, SSE integration green, and package lint/typecheck/build green.
- 2026-08-12 WEB-16 done — Closed the final WEB-14-dependent acceptance gap with a single keyboard-only prompt→preview→release→successful-deploy path, preserved the existing usage/billing/Owner-audit and exact activation contracts, and passed focused web E2E 6/6 plus activation 3/3, lint, and typecheck; no provider call was required.
- 2026-08-12 WEB-15 done — Added the public production health/synthetic/monitoring annotation view, Fix creation, healthy-target selection, and non-mutating database compatibility preview that blocks incompatible and unapproved-compensation rollback; focused E2E passed 1/1 and web lint/typecheck/build passed.
- 2026-08-12 WEB-14 done — Connected readiness/actions, server-classified confirmation, keyed deployment, live progress polling, safe failure actions, terminal success, custom-domain and rollback links through the generated public SDK; focused E2E passed 4/4 and web lint/typecheck/build passed.
- 2026-08-12 WEB-16-FIX-1 done — The DEP-12a pre-push cold gate exposed WEB-16's manifest/test contract drift: the new activation test restored a broad glob while the gate still required the enumerated non-rebuilding command. Enumerated activation alongside the existing Node tests so it runs without weakening the cold task-graph assertion.

- 2026-08-11 WEB-COLD-FIX-2 done — Updated the stale cross-package manifest assertion exposed by the uncached OPS-4 pre-push gate; the config suite now covers the shipped cleanup-unit-plus-Playwright command without changing build scheduling, and no provider call was required.
- 2026-08-11 WEB-COLD-FIX-1 done — Removed only the absolute web `.next` before fixture ports bind, added exact-target/tree/sibling coverage, and passed final 2/2 unit plus build→88/88 E2E, lint, typecheck, and capped review; the previously captured cold manifest/chunk failure was the RED while one fresh pre-fix rerun was non-reproducing, and no provider call was required.
- 2026-08-05 WEB-1 done — Next.js scaffold uses the generated SDK for CP-2 cookie-session validation, per-user active organization context, and explicit device consent; independent review passed after three rounds, 18/18 E2E passed on Node 26 and 22, and the uncached repository gate passed 34/34 (live Stytch remains credential-gated).
- 2026-08-05 WEB-2 done — shipped semantic Tailwind v4 tokens and 23 React components with CI-wired Storybook axe (23/23), Next+Vite package-boundary proofs, independent review clean after three rounds, UI 16/16, web 19/19, and the uncached repository gate passed 38/38.
- 2026-08-05 WEB-3 BLOCKED — independent review found that the locked run API cannot carry the required model or Web/Mobile selection; ADR-0009 proposes structured public/durable fields. The task stays unchecked, and its uncommitted branch also retains five repair findings for resumption.
- 2026-08-05 WEB-4 BLOCKED — the binding New project → home composer modal depends on blocked WEB-3; dashboard work is deferred intact while independent WEB-5 proceeds.
- 2026-08-05 WEB-5 done — shipped the tenant-scoped responsive builder shell with persisted resizing and Mission Control, 39/39 web E2E, clean independent spec and quality reviews after three rounds each, and an uncached Node 22 repository gate of 38/38.
- 2026-08-06 WEB-3 done — shipped the prompt-first home, public structured run intent, Builder-safe model projection, real default-off PostHog flag subscription, and resilient first-prompt handoff; independent closure review approved, home+builder E2E passed 39/39, control/API tests passed 77/77, SDK tests passed 50/50, PostgreSQL auth passed 3/3, and lint/typecheck/build were green (2 live Stytch tests skipped: no `STYTCH_PROJECT_ID` / `STYTCH_SECRET`).
- 2026-08-06 WEB-4 BLOCKED — API-first prevents implementing the binding dashboard from the current public contracts: `GET /v1/projects` has no last-activity, preview/production status, or deploy-readiness projection, and the GitHub installation repository-picker/import-progress APIs are owned by pending INT-1/INT-2. The task remains unchecked until those interfaces land; no fixture-only or inferred UI state was introduced.
- 2026-08-07 WEB-4 phased by ADR-0021 — WEB-3 plus the public membership/project-list SDK contracts unblock a truthful base slice (switcher, paginated name/support/Open grid, empty state, reused new-project composer). Summary/readiness and GitHub slices remain blocked; task and tracker stay unchecked.
- 2026-08-07 WEB-4 review round 1 — hardened base pagination with abort+generation gating across A→B→A, replaced stale organization URL overrides through Next history semantics, narrowed unsupported four-action recovery to truthful Retry-only reads, added polite loading status, and corrected ADR-0021's API-first citation; task and tracker remain unchecked.
- 2026-08-07 WEB-4 Slice A done — shipped the API-backed base dashboard after independent review round 2 passed with no findings; 65/65 web tests plus lint, typecheck, format, and build passed locally. Slices B/C, the prescribed completion commit, and the tracker remain unchecked; GitHub Actions is unverified because billing prevented every job from starting.
- 2026-08-07 WEB-4 BLOCKED — upstream/main still lacks a versioned project-summary/readiness SDK contract for Slice B and the INT-1/INT-2 repository-picker/import-progress SDK operations for Slice C; `./scripts/dev-up.sh` also exited 1 after all containers became healthy because the LocalStack queue `zapp-github-webhooks` is missing. The task and tracker remain unchecked.
- 2026-08-06 WEB-6 BLOCKED — the public event/API surface cannot yet implement the binding conversation contract: `AgentEvent` has no assistant-message event/payload contract, no public continuation or attachment-upload route exists, and the producing AR-6/AR-8 session workflow is unfinished. API-first forbids a browser-private message channel, so the task remains unchecked until those backend interfaces land.
- 2026-08-07 WEB-6 BLOCKED — re-audit on `upstream/main` `0a332c4` found AR-6/AR-8 landed but the public contract gap remains: the SSE `AgentEvent` union still has no assistant-message event or type-specific payload schemas, AR-8 drops the session summary and emits neither phase events nor tool `userSummary`, and the generated `/v1` SDK has no attachment-upload or conversation-continuation operation. API-first forbids fixture-private payload conventions or browser backdoors, so the task and tracker remain unchecked; `./scripts/dev-up.sh` reached healthy services before the known missing LocalStack `zapp-github-webhooks` queue exit, and a direct cold-worktree web baseline stopped before tests because dependency `dist` artifacts had not yet been built.
- 2026-08-08 M1-CI-playwright done — restored and installed the lockfile-pinned Chromium before the CI Turbo test DAG; exact ordering regression, actionlint, UI lint/typecheck, and focused tests passed with no provider runs.
- 2026-08-08 WEB-6 unblocked by ADR-0027 — the missing public conversation contract (typed `message.*` events, required tool `userSummary`, `POST /v1/runs/:runId/messages` continuation, attachment upload) is now defined and assigned: CP-20 (plan 02) and AR-22 (plan 04) precede WEB-6 in the tracker. WEB-6 executes against the regenerated SDK once both land; assistant streaming deltas remain M2.
- 2026-08-10 WEB-6 done — shipped the public-SDK event-sourced conversation, keyed continuation/new-run retry handling, persisted run controls, live progress, cancellation, and image paste/upload capped at 10; two review rounds closed with 74/74 web tests plus repository lint/typecheck green.
- 2026-08-10 WEB-4 done — Slices B/C shipped; review round 1 found duplicate import submission, shared discovery abort, and active-close identity loss, all fixed test-first, and round 2 accepted; projects E2E passed 17/17, full web passed 82/82, API client passed 52/52, web/root lint and typecheck plus web build and the cold gate passed (90/90 package tasks, 21/21 integration tasks, tenant isolation 54/54); credential-aware GitHub live checks skipped for missing GitHub App callback/discovery credentials, verification-only ports 3114/4114 were temporarily used while a sibling owned 3100/4100 and fully restored, and the final cold gate loaded the existing `.env` after initial contention/timeouts; no product deviation.
- 2026-08-10 WEB-7 done — shipped the public-SDK live preview, lifecycle states, bounded cursor logs, expiring share renewal, capture drawer, keyed recovery actions, and structured screenshot-to-composer handoff; final review residuals were re-scoped to WEB-7-FIX-1 and no provider call was required.
- 2026-08-10 WEB-7-FIX-1 done — fenced workspace transitions and concurrent actions, retained screenshot keys through body consumption, refreshed terminal failure logs, acknowledged composer capacity, and passed two fresh review rounds with no provider call.
- 2026-08-10 WEB-7-FIX-2 done — reconciled the preview Fix action with AR-19's strict public request, uploaded retry-stable screenshot evidence with the implicated commit and boot log, passed 76/76 browser and 55/55 SDK tests, and required no provider call.
- 2026-08-11 WEB-8 done — shipped trusted iframe element selection with stale-preview fencing, public screenshot attachments, bounded canonical context, and a 77/77 web E2E acceptance run; no provider call was required.
- 2026-08-11 WEB-9 BLOCKED — the generated public SDK supports the Mission Control aggregate plus pause/resume/cancel/redirect, but exposes neither eligibility fields nor operations for PRD §14.3 retry-failed-task and skip-optional-phase actions; the only run-approval resolution route is structurally budget-increase-only. API-first and the structural-over-heuristic constraint forbid mapping these actions to natural-language redirects or fixture-private behavior, so WEB-9 remains unchecked pending an approved public builder-control/approval contract expansion.
- 2026-08-11 WEB-10 BLOCKED — public `message.assistant` events expose only plain content or an artifact reference, not typed interview questions, specification summaries, plan review payloads, or typed approval-card data; no public plan-approval signal route exists, and run-approval resolution is budget-increase-only. API-first and the no-prose-parsing constraint forbid fixture-private card payloads or inferred plan state, so WEB-10 remains unchecked pending an approved structured conversation-card and generic approval contract.
- 2026-08-11 WEB-11 BLOCKED — the generated public SDK exposes dev-server logs and aggregate Mission Control test/commit summaries, but no browser-safe workspace file list/read/direct-edit commit operations, no commit before/after diff operation, and no test-case or evidence-artifact read/download operations. API-first forbids direct workspace-agent access or fixture-private file/evidence routes, so WEB-11 remains unchecked pending approved public code, diff, and verification-evidence contracts.
- 2026-08-11 WEB-17 BLOCKED — the public project-create contract accepts `sourceType: "template"` but no template identity or `repoRef`, and CP-6 still provisions an empty internal repository for every create. Shipping the gallery while making Remix create an empty project would be a false success, so WEB-17 remains unchecked pending an approved public template registry/source-clone contract.
- 2026-08-12 WEB-9 done — Replaced the empty shell with typed aggregate views and SDK-backed run/task/phase/approval actions, reconciled by bounded refresh; focused Playwright and web gates passed.
- 2026-08-12 WEB-10 done — Rendered typed question/specification/plan/generic approval cards directly from validated events and public SDK reads/mutations; connected Playwright flow and web gates passed.
- 2026-08-12 WEB-11 done — Replaced placeholder tabs with tenant-scoped file/edit/diff, searchable follow logs, and test/evidence/Fix-run surfaces; focused Playwright and web gates passed.
- 2026-08-12 WEB-17 done — Added the public template gallery/detail demo, server-resolved slug Remix, and seeded builder handoff; focused Playwright passed 2/2 and web lint/typecheck passed without provider calls.
- 2026-08-12 WEB-12 done — Added SDK-backed project settings for write-only secrets, all five integrations (including the missing public Vercel connect route), member roles/invites/deploy policy, GitHub sync/export, and archive/delete; focused E2E passed 2/2 with a network-level secret-value assertion and read-only Viewer proof.
- 2026-08-12 WEB-13 done — Added SDK-backed release history/detail pages with support and active-production markers, deployment/rollback data, actionable lifecycle controls, and a complete evidence/criteria report; focused E2E passed 1/1 including prominent failed and unverified criteria.
- 2026-08-11 WEB-4 controller correction done — under explicit bounded post-cap authority, added independently paginated/deduped branch discovery with keyboard page-2 selection, preserved durable import identity and public progress across close/reopen without create/enqueue replay, consumed failed callbacks before completion to prevent credential replay, and cleared aborted branch loading synchronously; all four fixes followed RED→GREEN, focused cases passed 5/5, projects E2E passed 17/17 on canonical ports, and web lint/typecheck/build plus API client 52/52 passed; the one-time live GitHub gate was not rerun and no product/API deviation was needed.
- 2026-08-11 WEB-12 BLOCKED — API-first audit found secrets and the organization `builderCanDeploy` setting available, but no public integration status/disconnect or Vercel operations, organization member-list read model, GitHub sync-policy/state/manual-sync/export operations, or project archive/delete pipeline; those contracts are owned by INT-1..4, DEP-5, and CP-17, so the task remains unchecked and no fixture-only settings state was introduced.
- 2026-08-11 WEB-13 BLOCKED — API-first audit found release detail/readiness and evidence-manifest reads, but no public project release-list read, active-production marker, deploy-history or rollback-target projection, or DEP-12 repair-fork operation; the task remains unchecked pending Plan 07 release lifecycle contracts, and no fixture-only release state was introduced.
- 2026-08-11 WEB-14 BLOCKED — API-first audit confirmed the prerequisite DEP-12 lifecycle is not live: the release service has no callable readiness/deploy/evidence/rollback runtime, and the public API exposes neither DEP-3 confirmation effects nor DEP-6 live deployment-stage reads/events. Rendering the flow from UI fixtures would create a browser-private success path, so the task remains unchecked and no mock-only deploy UI was added.
- 2026-08-11 WEB-15 BLOCKED — API-first audit found no public production-health, synthetic-history, release-annotation, deploy-history, rollback-target, or DEP-9 database-compatibility projection for this screen; its DEP-12/OPS-8 prerequisites are also incomplete. The task remains unchecked and no inferred Grafana/Faro or rollback state was introduced.
- 2026-08-12 WEB-16 phased — Shipped versioned credit burn-down plus generated SDK, authoritative Stripe-synced seat status, usage/billing/audit screens, budget alerts, exact org-scoped activation events, axe-clean home/dashboard/builder/deploy-readiness entry, and keyboard-activated prompt/create/preview/deploy-entry slices; one capped review's three Important findings were fixed, real PostgreSQL credit/seat lifecycle tests passed, and the final web gate passed 95/95. The connected successful prompt→preview→deploy acceptance remains BLOCKED on WEB-14's missing public deploy lifecycle, so WEB-16 and its tracker remain unchecked; no provider call was required.
- 2026-08-14 WEB-18-FIX-6 done — Unified local auth, CORS, readiness, and browser launch on `127.0.0.1`; preserved redeemed Redis preview grants for keyed refresh replay; verified real session bootstrap, preview share/exchange/redeem, 134/134 browser tests, 115/115 workspace-agent tests after one cold-suite concurrency failure, and the complete pre-push repository gate; GitHub, Supabase, Neon, and generated-app Stripe live tests remained visibly credential-gated.
