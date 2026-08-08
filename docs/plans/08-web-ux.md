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

**Files:** Create: `src/app/projects/page.tsx`, `src/components/projects/*`, `e2e/projects.spec.ts`, `docs/adr/0021-phased-web-4-without-inferred-state.md`; Modify: `src/lib/api.ts` (generated-SDK wrapper only), `src/components/home/PromptComposer.tsx` (context flag to suppress the blocked GitHub control while reusing the WEB-3 composer), this WEB-4 task/log in `docs/plans/08-web-ux.md`
**Effort:** M

Phased delivery is governed by accepted ADR-0021. The task and tracker remain unchecked until all three slices are complete; an independently green base slice is not task completion.

- [x] **Slice A — API-backed base dashboard:** `/projects`; organization switcher populated from active `/v1/me` memberships and persisted with the WEB-1 per-user selection; keyset-paginated `GET /v1/projects` infinite grid; cards show **name, support-level badge, and Open only**; truthful empty state; `New project` opens a dialog reusing WEB-3's prompt composer/public create-project + create-run flow. Switching organization resets accumulated items/cursor, aborts prior list work, advances a request generation, removes a stale `organizationId` URL override via Next router replacement while preserving unrelated query parameters, and announces loading as a polite status. Initial and pagination responses may mutate state only for their captured current generation. Per ADR-0021, base membership/project read failures expose only a real **Retry**; Fix automatically, Inspect details, and Ask the agent stay absent until distinct public capabilities/context exist. Do not render or infer last activity, status dots, preview/production state, readiness, deploy, or GitHub state.
- [x] **Slice A e2e:** two-org user switches organizations → different project lists and each list request carries the selected `x-organization-id`; an Alpha→Beta→Alpha race proves stale pagination cannot append or advance/skip the fresh cursor; URL replacement preserves unrelated query parameters/history semantics and refresh uses the persisted selection; opaque `nextCursor` loads the next page once without duplicates; switch loading is announced via `role=status`; a failed list exposes a working Retry only; empty organization renders the empty state; New project opens the reused WEB-3 composer.
- [ ] **Slice B — blocked on a public project-summary read model:** add last activity, preview/production status with icon + text (never color alone), and Deploy quick action only when API-returned readiness permits it. No fixture-only or browser-inferred summary state.
- [ ] **Slice C — blocked on INT-1/INT-2 public APIs:** add `Import from GitHub` → installation → repository picker → import progress through generated SDK operations. No fixture-only GitHub state or UI-private route.
- [ ] Commit: `feat(web): dashboard with org switcher + github import entry`

### Task WEB-5: Builder shell layout

**Files:** Create: `src/app/projects/[id]/page.tsx`, `src/components/builder/{Shell,TopBar,SurfaceTabs}.tsx`
**Effort:** M

Layout (PRD §10.0.2): top bar: project name + support badge + env badge, actions right: `Preview` (focus preview tab), `GitHub` (sync state pill: synced/ahead/diverged), `Deploy` (primary, enabled once a preview exists), Mission Control toggle, settings gear. Split: left conversation pane (min 380px, 40%), right surface (60%) tabs `Preview | Code | Logs | Tests`; Mission Control = right-side `Drawer` (overlay ≥ 1280px pushes content), collapsible, state persisted; responsive: < 1024px stacks with bottom tab switcher (conversation default).

- [x] e2e: pane resize persists; deploy disabled pre-preview with tooltip; Mission Control opens without navigation (URL unchanged, PRD §14.1).
- [x] Commit: `feat(web): builder two-pane shell with mission control drawer`

### Task WEB-6: Conversation stream (M1 subset)

**Files:** Create: `src/components/conversation/{Thread,Composer,MessageBubble,ToolActivityLine,ProgressCard}.tsx`, `src/hooks/useRunEvents.ts`
**Effort:** L

- [ ] Binding behavior: `useRunEvents(runId)` = SSE subscribe (resume via last sequence from cache) reducing events → thread items: assistant text (`Markdown`), concise activity lines from `tool.started/completed` **userSummary strings** (grouped: "Edited 3 files · Ran build ✓" collapsible to detail), `ProgressCard` for `phase.*` events (phase name, step dots, elapsed), commit chips (`commit.created` → sha7 + message, click → Code tab diff); composer: send message (continues run or starts new one per mode), Stop button during active run (cancel signal), attach: image paste/upload, and the same `+` menu as WEB-3 (Upload file / Import from GitHub / Auto ▸ mode-model selector / Advanced controls) with the selection persisted per project; reconnect banner on SSE drop with silent catch-up (no duplicates — sequence dedupe test).
- [ ] e2e with seeded event fixture stream: renders text, activity groups, progress card; kill SSE → reconnect → no dupes; Stop fires cancel and UI reflects `run.cancelled` ≤ 5 s.
- [ ] Commit: `feat(web): event-sourced conversation thread`

### Task WEB-7 [M2]: Preview panel

**Files:** Create: `src/components/preview/{PreviewFrame,PreviewToolbar,ConsoleDrawer}.tsx`
**Effort:** L

- [ ] Binding behavior: iframe on Modal connect URL (WS-12); toolbar matches the benchmark pattern: centered device-size toggles (desktop/tablet/mobile widths), top-right open-in-new-tab + refresh, URL path bar (route-change events update it), share (WS-12 share records UI), env badge "Preview"; states (PRD §26A.1): starting (skeleton + boot log tail), sleeping (wake CTA → workspace start), stale (banner "Preview is behind latest changes — Restart"), disconnected (retry), failed (ErrorState with actions incl. "Fix automatically" → Fix run with boot log attached); console/network drawer fed by proxy capture events (`/__zapp/events` relayed via preview status events): error rows carry "Attach to chat" button.
- [ ] e2e (fixture proxy): state transitions render; console error attaches to composer as structured attachment.
- [ ] Commit: `feat(web): live preview panel with states + capture drawer`

### Task WEB-8 [M2]: Element selection + rich attachments

**Files:** Create: `src/components/preview/SelectMode.tsx`, composer attachment chips
**Effort:** M

- [ ] Binding behavior: "Select element" toolbar toggle → postMessage to zapp-client (WS-10) → hover outlines in iframe → click returns `{ selector, role, text, boundingBox, componentHint, screenshot }` → attachment chip in composer ("Selected: `<Button> 'Save'` on /settings"); attachments serialize into run message payload (AR consumes as structured context, PRD §10.0.1 step 6); screenshot attachments auto-captured for error attachments.
- [ ] e2e: select → chip → sent message payload contains selector JSON (network assertion).
- [ ] Commit: `feat(web): visual element attach for change requests`

### Task WEB-9 [M2]: Mission Control drawer

**Files:** Create: `src/components/mission-control/{Overview,TaskGraph,Agents,Activity,FilesCommits,Tests,Approvals,Risks}.tsx`
**Effort:** L

- [ ] Binding behavior (PRD §14.2/§14.3): tabs: **Overview** (current phase, progress bar, live cost vs budget from `usage.recorded`, preview status), **Tasks** (dependency graph — dagre layout, nodes colored+iconed by state, click → task detail: AC, commits, evidence), **Agents** (active roles + current tool), **Activity** (recent tool calls list, user-language summaries, "raw detail" expander = optional per §14.1), **Files/Commits** (diffstat list → Code tab), **Tests** (runs, failures, screenshots), **Approvals** (open approval cards + history), **Risks** (risks_json from verifier); actions bar: Pause/Resume/Cancel (confirm)/Redirect (opens composer scoped "redirect" input), Retry failed task, Skip optional phase, Open preview, Compare commits (before/after → Code diff); all actions optimistic + reconciled by events; `aria-live` announcements on phase/task state changes.
- [ ] e2e on fixture event stream: graph renders states; pause→paused pill ≤ 5 s; approval card resolve flows.
- [ ] Commit: `feat(web): mission control drawer (views + actions)`

### Task WEB-10 [M2]: Interview, spec summary, plan approval cards

**Files:** Create: `src/components/conversation/{QuestionCard,SpecSummaryCard,PlanReviewCard,ApprovalCard}.tsx`
**Effort:** L

- [ ] Binding behavior (PRD §10.0.1 steps 2–3, §12.3, §13.1): QuestionCard renders grouped compact form (radio/checkbox/short-text per question option payload) + free-text alternative — one submit returns structured answers; SpecSummaryCard: agent's understanding summary + expandable full spec (sectioned; inline edit per section → consequence note from agent before accept), actions: **Start building** (primary) / Keep discussing / Edit details; PlanReviewCard: phases accordion (tasks, AC count, risk chips, cost/effort estimate, approval points), actions Approve plan / Request changes; ApprovalCard (generic, drives AR-14/AR-20/deploy approvals): typed payload rendering (budget increase, plan diff (added/removed/modified lists), destructive migration with SQL preview) + Approve/Reject + reason.
- [ ] e2e: scripted interview → answers submitted as structured payload; spec approve → `POST .../approve` called; plan diff card renders fixture diff.
- [ ] Commit: `feat(web): interview + spec/plan approval cards`

### Task WEB-11 [M2]: Code, Logs, Tests surfaces

**Files:** Create: `src/components/code/{FileTree,CodeView,DiffView}.tsx`, `src/components/logs/LogView.tsx`, `src/components/tests/{TestRuns,EvidenceViewer}.tsx`
**Effort:** L

- [ ] Binding behavior: **Code**: file tree (lazy via workspace files API), CodeMirror read view; edit mode for Owner/Builder (save = `write_file` through a user-attributed direct-edit endpoint creating its own commit "manual edit via web"); diff view for any commit (before/after, PRD §14.3 compare); **Logs**: dev-server + tool output streams (xterm.js, follow toggle, search) — reads WS-13 log API + tool.output events; **Tests**: `test_runs` list → cases with status/duration, evidence viewer: screenshots (with text description), console/network captures, Playwright trace download link; failed case → "Create Fix run" button (AR-19 entry).
- [ ] e2e: open file renders content; commit diff renders; failed test fixture shows screenshot + fix CTA.
- [ ] Commit: `feat(web): code/logs/tests surfaces`

### Task WEB-12 [M3]: Settings — secrets, integrations, members, GitHub

**Files:** Create: `src/app/projects/[id]/settings/*` pages
**Effort:** L

- [ ] Binding behavior: Secrets: name+env scoped add (value write-only — after save shows metadata only, rotate = re-enter, PRD §22.2 "no read through UI"); Integrations: connect cards for GitHub/Supabase/Neon/Stripe/Vercel (status, connected account, disconnect) driving §32.5 routes; Members: org members with roles (Owner edits), invite flow, `builderCanDeploy` toggle (Owner); GitHub: sync policy picker (direct push / PR), sync state, manual sync now, export button; Danger: archive/delete with typed-name confirm (delete → CP-17 pipeline notice on timeline).
- [ ] e2e: secret value never appears in any response after creation (network-level assertion); viewer sees no settings mutations.
- [ ] Commit: `feat(web): project settings suite`

### Task WEB-13 [M3]: Releases + evidence viewer

**Files:** Create: `src/app/projects/[id]/releases/*`
**Effort:** M

- [ ] Binding behavior: release list (status, commit, env, support badge, created by/at, active-in-prod marker); detail: evidence manifest rendered as the Appendix D report (sections with pass/fail/waiver chips + artifact links), criteria table (VF-9: every criterion with result — unverified/failed never hidden), rollback target, deploy history; actions: Deploy (if ready+approved role), Fork to repair branch (DEP-12).
- [ ] e2e: fixture manifest renders all criteria incl. a failed one prominently.
- [ ] Commit: `feat(web): release history + evidence report viewer`

### Task WEB-14 [M3–M4]: Deploy flow UI

**Files:** Create: `src/components/deploy/{ReadinessSheet,ConfirmDialog,StageTimeline,SuccessCard}.tsx`
**Effort:** L

- [ ] Binding behavior (PRD §26A): Deploy click → ReadinessSheet: three-state header (**Ready to deploy** green / **Warnings found** amber / **Deployment blocked** red) + findings list with per-finding action buttons (Fix and recheck → Fix run; Review; Waive where allowed w/ reason) — copy exactly from DEP-2 payloads; continue → ConfirmDialog: deployment type headline (First deploy / Redeploy / Replace deployment) + DEP-3 confirmation payload verbatim (data/secrets/URL/user impact bullets; Replace requires explicit data-disposition radio before enabling confirm); deploying → StageTimeline (8 DEP-6 stages, live status/elapsed/summary, failure = inline evidence + actions Retry stage-safe / Fix automatically / Ask agent, previous release banner "Production unaffected"); success → SuccessCard per §26A.5 (URL copy, Add custom domain, release id/commit, evidence link, health status, monitoring links, Rollback to rel_… secondary, "future changes stay in preview until you redeploy" note).
- [ ] e2e: blocked state disables continue; replace w/o disposition disabled; timeline renders failure without success state; success card fields from fixture payload.
- [ ] Commit: `feat(web): readiness → confirm → staged deploy → success flow`

### Task WEB-15 [M4]: Observability + health + rollback UI

**Files:** Create: `src/app/projects/[id]/health/page.tsx` (or surface tab), rollback dialog
**Effort:** M

- [ ] Binding behavior: production health card (health checks, error rate from Grafana link-through (Faro/Loki panels), web vitals summary from Faro where available, synthetic check history sparkline + last failures with "Create Fix run"); release annotations timeline; Rollback dialog: target release picker (previous healthy default) + DEP-9 `databaseState` rendering — `incompatible` blocks with explanation, `requires_compensation` shows plan requirement (never "rollback complete" implication for DB, PRD §27.5).
- [ ] Commit: `feat(web): production health + guarded rollback UI`

### Task WEB-17 [M2]: Template gallery + detail with live preview & Remix

**Files:** Create: `src/app/templates/{page,[slug]/page}.tsx`, `src/components/templates/*`, `config/templates.json`
**Effort:** M

- [ ] Binding behavior (benchmark screenshots 2–3; PRD §8.1 templates + community templates): template registry `config/templates.json`: `{ slug, name, description, pagesIncluded[], highlights[] (e.g. "Auth pre-built", "AI included"), demoUrl (pre-deployed static demo), repoRef (template repo in internal Git), stack }`; gallery grid from home ("Try these" chips deep-link here too); detail view mirrors the benchmark layout: left info panel (name, description paragraph, "Pages included" chips, Highlights badges), right = live demo preview iframe (`demoUrl`) with the WEB-7 toolbar pattern (device toggles centered, open-in-new-tab + refresh top-right); primary action **"Remix this template"** → creates project from `repoRef` (CP-6 template source) and opens the builder with a seeded first message ("I'm starting from the <name> template"); demo previews are pre-deployed once per template release (no live sandbox needed for browsing).
- [ ] e2e: gallery renders registry; detail shows chips/highlights + iframe; Remix creates project and lands in builder.
- [ ] Commit: `feat(web): template gallery + detail with demo preview and remix`

### Task WEB-16 [M5]: Usage/billing, audit log, a11y pass, activation instrumentation

**Files:** Create: `src/app/org/{usage,billing,audit}/page.tsx`; a11y fixes across app
**Effort:** L

- [ ] Binding behavior: Usage: credits balance, burn-down by project/run/category (ledger aggregates), budget alerts config; Billing: plan card, seats, payment method (Stripe portal link), top-up credits (OPS-5 checkout); Audit: filterable table (Owner only); a11y: axe clean on home/dashboard/builder/deploy (CI gate), full keyboard e2e for prompt→preview→deploy path; activation analytics (PostHog via OPS-6): `signup, project_created, first_preview_ready, first_change_applied, plan_approved, first_deploy_succeeded` fired from event stream (client-side, org-scoped).
- [ ] Commit: `feat(web): usage/billing/audit + accessibility gate + activation funnel`

---

## Testing strategy
- Storybook + axe per component; Playwright e2e per screen task against a **fixture-mode API** (seeded events/read models — no live agents needed for UI CI); one nightly staging e2e running the full prompt→preview→deploy happy path (ties to master E1).

## Scalability notes
- Event reducers are pure + memoized; thread virtualization (long runs = thousands of events) via windowing; SSE single connection per run shared through context.

## Security & tenancy notes
- No secret values ever render (write-only UI verified by e2e network assertions); org header injected centrally; support-visibility events never requested by user clients.

## Execution log

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
