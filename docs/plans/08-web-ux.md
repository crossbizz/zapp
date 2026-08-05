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

- [ ] Binding behavior: components (each with story + a11y test via storybook axe): `Button, IconButton, Chip, Tabs, Card, StatusPill, EnvBadge, SupportLevelBadge, Drawer, Dialog, Tooltip, Avatar, CreditsPill, ProgressBar, Spinner, Timeline, TimelineStage, EmptyState, ErrorState(actions), Kbd, CodeBlock, Markdown, Toast`. Token CSS vars per Design system section; **Vite smoke build must pass in CI** (desktop reuse risk, master risk table).
- [ ] Commit: `feat(ui): design system tokens + core components (Next+Vite)`

### Task WEB-3: Home screen (Emergent-modeled)

**Files:** Create: `src/app/(home)/page.tsx`, `src/components/home/{Hero,PromptComposer,SuggestionChips}.tsx`, e2e `e2e/home.spec.ts`
**Effort:** M

Layout spec (mirrors benchmark screenshot, zapp copy):
- Full-bleed hero: `--zapp-hero` sky gradient, top bar overlay: left `Home` pill (grid icon), right `CreditsPill` (remaining credits, click → /org/usage) + `Avatar` menu (orgs, settings, sign out).
- Centered H1 (32px, white): **"Start with one prompt. We'll take it to production."** (copy config-driven; structural parity with benchmark's "Start with one prompt. You can change everything later.").
- Tabs card: `Web App` (active) | `Mobile App` (behind PostHog flag `mobile-app-tab`; while off, disabled with tooltip "Coming after P0"). 
- Prompt card (`rounded-2xl`, white, shadow): textarea placeholder *"Describe your idea. zapp will build, test, and ship it."*, autosize 3→10 rows; bottom-left `+` opens a menu exactly matching the benchmark screenshot: **Upload file** (files/images), **Import from GitHub** (→ WEB-4 import flow), **Auto ▸** (mode & model selector submenu: "Auto (recommended)" default; modes Ask / Prototype / Build / Fix / Autonomous with one-line descriptions; model picker within org model policy), **Advanced controls** (run budget cap, target branch); bottom-right: mic button (behind PostHog feature flag `voice-input`, default off — OPS-6 catalog) + circular submit arrow (disabled until ≥ 10 chars). Selected mode/model chips render above the composer when non-Auto.
- Below: "Not sure where to start? Try these ⇄" shuffle + 3 `Chip`s with colored-dot icons, rotating from a 9-item config list (e.g. "Client portal for an agency", "Class scheduler for a yoga studio", "SaaS dashboard with Stripe billing"). Click → fills composer (not auto-submit).
- Bottom-right support bubble (links to docs/support mail P0).
- Submit → `POST /v1/projects` (name auto-derived) + `POST /v1/projects/:id/runs` (mode: recommended per prompt heuristic — Prototype for exploratory wording, Build otherwise; user can change in builder) → route `/projects/:id` with composer text as first message.

- [ ] Failing e2e: renders hero + tabs + chips; typing < 10 chars keeps submit disabled; chip click fills composer; submit navigates to builder with first message visible; keyboard-only path works (tab order: tabs → composer → attach → submit → chips).
- [ ] Commit: `feat(web): prompt-first home screen`

### Task WEB-4: Projects dashboard + org switcher + new/import

**Files:** Create: `src/app/projects/page.tsx`, `src/components/projects/*`
**Effort:** M

- [ ] Binding behavior: grid cards: name, support-level badge, last activity, env status dots (preview/prod), quick actions (Open, Deploy if ready); header: org switcher (memberships), `New project` (→ home composer modal) and `Import from GitHub` (INT-1 install → repo picker → import progress); empty state mirrors home hero CTA; keyset pagination infinite scroll.
- [ ] e2e: two-org user switches orgs → different project lists (tenancy visible in UI tests too).
- [ ] Commit: `feat(web): dashboard with org switcher + github import entry`

### Task WEB-5: Builder shell layout

**Files:** Create: `src/app/projects/[id]/page.tsx`, `src/components/builder/{Shell,TopBar,SurfaceTabs}.tsx`
**Effort:** M

Layout (PRD §10.0.2): top bar: project name + support badge + env badge, actions right: `Preview` (focus preview tab), `GitHub` (sync state pill: synced/ahead/diverged), `Deploy` (primary, enabled once a preview exists), Mission Control toggle, settings gear. Split: left conversation pane (min 380px, 40%), right surface (60%) tabs `Preview | Code | Logs | Tests`; Mission Control = right-side `Drawer` (overlay ≥ 1280px pushes content), collapsible, state persisted; responsive: < 1024px stacks with bottom tab switcher (conversation default).

- [ ] e2e: pane resize persists; deploy disabled pre-preview with tooltip; Mission Control opens without navigation (URL unchanged, PRD §14.1).
- [ ] Commit: `feat(web): builder two-pane shell with mission control drawer`

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
