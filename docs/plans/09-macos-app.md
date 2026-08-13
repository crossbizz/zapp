# Plan 09 — macOS Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The zapp.build macOS app on the Dyad Electron Forge shell (Apache code outside `src/pro`): local, Docker, and cloud runtime modes, platform auth, shared Mission Control/builder UX, Git-based sync — PRD §21, §38.1.

**Architecture:** Fork Dyad into `apps/desktop`, remove `src/pro` imports, rebrand, and progressively swap Dyad's local agent internals for zapp contracts: the Electron main process implements `WorkspaceRuntime` (WS-1) for local + Docker modes; cloud mode makes the desktop a thin client of the same control plane (api-client + SSE) with UI composed from `packages/ui`. Sync is Git-only (Global Constraint 13).

**Tech Stack:** Electron Forge (Dyad config preserved), Vite + React renderer, `packages/{ui,api-client,contracts,workspace-runtime}`, node-pty, dugite/bundled git, Keychain via `keytar`-equivalent (Electron safeStorage), Squirrel auto-update (R2-hosted feed).

**Milestone:** MAC-1..3 (M0), MAC-4..6 (M2), MAC-7..10 (M4), MAC-11..12 (M5). **Depends on:** Plans 01, 02 (auth/API), 04 (events), 08 (ui package). **Consumed by:** P0 exit criteria E2/E3/E5.

## Global Constraints

Master plan §Global Constraints, plus:
- `apps/desktop` may keep Dyad's internal structure where practical — invasive refactors minimized to ease upstream merges (PRD §41 risk); zapp-specific code in `apps/desktop/src/zapp/*`.
- No `src/pro` file, import, or derived code (FND-9 lint runs on this workspace too).
- Local mode: platform tokens only in Keychain/safeStorage — never plaintext config files.
- Cloud state rendering uses the same event reducers as web (shared package) — zero desktop-only state protocols.

---

### Task MAC-1: Fork + de-Pro + headless build proof

**Files:** Create: `apps/desktop/` (Dyad fork), `docs/adr/0002-dyad-fork.md`
**Effort:** L

- [x] **Step 1:** Vendor Dyad at a pinned commit (recorded in ADR + NOTICE); remove `src/pro` directory; build until clean: stub/no-op every Pro import site (each site marked `// zapp: pro-removed`), feature-flag Pro-only UI off.
- [x] **Step 2:** Prove: `pnpm --filter desktop start` launches; create/open a local Vite template project; chat panel renders (model calls may be non-functional until MAC-6 — UI boots is the bar); `pnpm --filter desktop make` produces a signed-less dev .app.
- [x] **Step 3:** FND-9 lint green on the fork (no pro imports); NOTICE updated.
- [x] Commit: `feat(desktop): dyad fork building without src/pro (PRD §38.1 exit)`

### Task MAC-2: Rebrand + packaging/signing/notarization CI

**Files:** Modify: `apps/desktop/forge.config.ts`, icons/assets, `.github/workflows/desktop.yml`
**Effort:** M

- [x] Binding behavior: identity `build.zapp.desktop`, product name "zapp", protocol `zapp://` (auth callback + deep links `zapp://project/{id}`), icon assets *(DMG maker deferred 2026-08-04: upstream ships none — genuinely new scope; stapled .app in .zip satisfies P0 distribution; revisit at public-beta polish)*; CI: macOS runner make → codesign (Developer ID cert in secrets) → notarytool staple → artifact upload; unsigned dev builds for PRs; auto-updater neutralized until a zapp feed exists (env-gated ZAPP_UPDATE_FEED — MAC-11 owns the feed).
- [ ] Verify: notarized build passes Gatekeeper on a clean machine (`spctl -a -vv`). *(UNVERIFIED 2026-08-04 — no Developer ID cert exists yet; gating structurally sound per review; first cert-bearing CI run is first execution. Reopens when certs provided.)*
- [x] Commit: `feat(desktop): zapp identity + signed/notarized packaging pipeline`

### Task MAC-3: Preserve-list regression suite

**Files:** Create: `apps/desktop/test/preserve.spec.ts` (Playwright-for-Electron smoke set)
**Effort:** M

- [x] Binding behavior: automated smoke for the PRD §21.1 preserve list that exists in Dyad today: local file access, terminal/PTY opens, bundled Git operations, local process management (dev server start/stop), local preview renders, window/protocol handling. Each = one spec; Docker specs env-gated to runners with Docker.
- [x] Commit: `test(desktop): dyad capability preservation suite`

### Task MAC-4 [M2]: Platform auth + Keychain

**Files:** Create: `apps/desktop/src/zapp/auth/*`
**Effort:** M

- [x] Binding behavior: device/PKCE flow (CP-2): app opens browser to hosted auth → `zapp://auth/callback` → exchanges for tokens → refresh token in `safeStorage` (Keychain-backed), access token memory-only; sign-out purges; org selector after auth; offline: cached identity renders, cloud features disabled with clear state.
- [x] Failing tests: token persisted encrypted (file content ≠ plaintext token); relaunch restores session without re-auth; revoked refresh → clean re-login prompt.
- [x] Commit: `feat(desktop): platform auth with keychain-backed sessions`

### Task MAC-4-FIX-1 [M2]: Close auth revocation and startup bounds

**Files:** Modify: `apps/desktop/src/zapp/auth/*`, `apps/desktop/src/main.ts`, `apps/desktop/src/ipc/preload/channels.ts`
**Effort:** S

- [x] Binding behavior: a failed durable logout must be drained before a later sign-in can overwrite its encrypted refresh token; cached identity becomes offline-visible within a bounded startup wait, and a later background refresh publishes a strict renderer state update.
- [x] Failing tests: logout failure + failed startup retry blocks a new device grant without losing the old token; a never-settling refresh returns the cached offline snapshot within the startup bound; background completion updates the renderer through the whitelisted event.
- [x] Commit with MAC-4: `feat(desktop): platform auth with keychain-backed sessions`

### Task MAC-5 [M2]: Cloud dashboard + shared client

**Files:** Create: `apps/desktop/src/zapp/{dashboard,project-list}/*`
**Effort:** M

- [x] Binding behavior: project list/dashboard via api-client (same read models as WEB-4); open cloud project → builder window in cloud mode (MAC-8); create-new routes through home-style composer (WEB-3 pattern, shared components); local projects section lists Dyad-style local folders side-by-side with cloud projects (source badge: Local / Cloud).
- [x] Commit: `feat(desktop): unified local+cloud project dashboard`

### Task MAC-5-FIX-1 [M2]: Preserve cloud creation retry identity

**Files:** Modify: `apps/desktop/src/zapp/dashboard/surface.tsx`, `apps/desktop/src/zapp/dashboard/surface.test.tsx`
**Effort:** S

- [x] Binding behavior: list-load failure and creation failure have distinct recovery controls; the visible creation retry replays the retained strict operation ID, and only prompt change, organization change, or full success clears that pending creation.
- [x] Failing test: an ambiguous create response followed by the rendered creation-retry control reuses the exact operation ID; list retry cannot clear the pending creation.
- [x] Commit with MAC-5: `feat(desktop): unified local+cloud project dashboard`

### Task MAC-5.5 [M2]: Restore hybrid integration coverage

**Files:** Modify: `apps/desktop/src/testing/hybrid_chat_harness.tsx`, `apps/desktop/src/testing/hybrid_chat_harness.guard.integration.test.tsx`, `apps/desktop/vite.preload.config.mts`, pre-existing lint cleanup in `apps/desktop/src/components/preview_panel/PreviewIframe.tsx`; Verify: `apps/desktop/e2e-tests/helpers/monaco_editor.ts`, `apps/desktop/e2e-tests/{edit_code,editor_commit_menu}.spec.ts`
**Effort:** M

- [x] Binding behavior: the hybrid renderer registers the same strict platform-auth IPC boundary as production with a deterministic signed-out session, so newly required composition channels cannot strand legacy integration surfaces; the shared Monaco helper continues to drive the real focused editor surface rather than its aria-hidden IME shim.
- [x] Failing test: the harness invokes `zapp-auth:snapshot`, receives the strict signed-out state, mounts a title-bar surface, and disposes with no missing production channel; retain the full-suite diagnostic inventory and re-run all 13 `local_agent_*` specifications.
- [x] Run the desktop Vitest suite as a bounded diagnostic inventory; run the 13 ADR-0002 `local_agent_*` behavioral specifications separately and preserve/report their intentional RED handoff to MAC-6; verify the strict auth harness and two Monaco Playwright specs green; commit `test(desktop): restore hybrid integration coverage`.

### Task MAC-6A [M2]: Local runtime + resumable-session foundation

**Files:** Create: `apps/desktop/src/zapp/runtime/{local,local-session}{,.spec}.ts`, desktop migrations, `services/orchestrator-worker/src/session/index.ts`; Modify: desktop schema/package, workspace-runtime environment seam, agent-tools mutation manifest, orchestrator session transcript/export, package manifests and lockfile
**Effort:** L

- [x] Binding behavior: provide a safe local `WorkspaceRuntime` with confined filesystem operations, allowlisted child environment, bundled Git, bounded PTY process-tree termination, and fail-closed guarded writes; package the AR-6 session loop behind an injected gateway and persist transcript state with SQLite compare-and-swap.
- [x] Commit behavior: successful mutation tools produce a strict durable changed-path manifest; construct the exact agent commit from the recorded base revision under a dedicated deterministic ref without mutating the user's branch or primary index; recover an ambiguous Git success from the durable commit intent.
- [x] Failing tests: runtime confinement/timeout/environment cases; lost commit response; unrelated pre-staged changes; concurrent branch advance and checkout; primary-index interposition.
- [x] Verify and review: affected tests/static checks green; two capped reviews plus the re-scoped closure review have zero remaining Critical/Important findings.
- [x] Commit: `feat(desktop): local runtime and resumable session foundation`

This foundation intentionally does not complete MAC-6. The public user-authenticated model-gateway/accounting boundary, renderer composition, local-mode policy, and explicit application of dedicated agent commits remain in MAC-6.

### Task MAC-6 [M2]: Local runtime adapter

**Files:** Create: `apps/desktop/src/zapp/runtime/local.ts`, `test/local-runtime.spec.ts`
**Effort:** L

- [x] Binding behavior (PRD §21.3 local mode): implement `WorkspaceRuntime` (WS-1 interface, `kind: "local"`) in the Electron main process: exec via node-pty/execa rooted at project dir (same path-guard util), fs ops, git via bundled git, dev-server supervisor with port detection; agent runs execute **locally**: a desktop-hosted session loop (AR-6 packaged for local: model calls still via platform model-gateway over HTTPS — Global Constraint 2 holds; tools bound to local runtime); run state persisted to local SQLite so app restart resumes conversation (no P0 guarantee of durable autonomous execution offline — Autonomous mode requires cloud, enforced: mode picker disables it in local mode with "Move to cloud" hint, PRD §21.3).
- [x] Failing tests: WS-1 conformance suite (shared test kit from WS-1 runs against local adapter — path escape, timeout, truncation); local chat edit round-trip commits to local git.
- [x] Commit: `feat(desktop): local WorkspaceRuntime + local agent sessions`

### Task MAC-6-FIX-1 [M2]: Structural local-agent containment + terminal recovery

**Files:** Modify: `apps/desktop/src/zapp/runtime/{local.ts,local-session.ts,local-agent-handler.ts}`, their existing specs, `tasks/todo.md`, this plan
**Effort:** M

- [x] RED: prove an unknown secret in `.env`, Git metadata, or another untracked/ignored file cannot reach a model request or SQLite transcript; prove no model-facing tool can dispatch repository-controlled Git hooks, filters, merge drivers, or arbitrary host commands.
- [x] RED: prove a failed, cancelled, or budget-exhausted durable turn can accept the next keyed user message, reconcile any owned partial mutation, refresh the per-message budget, and produce a fresh completion/commit.
- [x] GREEN: expose only tracked or agent-owned files through a `.git`-denying model runtime; remove every model-facing Git mutator; build/apply exact agent commits through configuration-independent Git plumbing with the recorded-base CAS and unrelated index/worktree preservation.
- [x] GREEN: durably linearize each new user-message continuation from every terminal state, preserving monotonic completion identity and exact per-turn commit reporting.
- [x] Verify: focused containment/recovery tests, MAC-6 owned suite, desktop type/lint, affected control/model suites, architecture checks, one final real-provider acceptance, max two reviews with exit zero Critical/Important.
- [x] Commit: `fix(desktop): contain and recover local agent turns`

### Task MAC-6-FIX-2 [M2]: Durable local turn results + mutation recovery

**Files:** Modify: `apps/desktop/src/zapp/runtime/{local.ts,local-session.ts,local-agent-handler.ts}`, their existing specs, `apps/desktop/src/db/schema.ts`, `apps/desktop/drizzle/*`, `tasks/todo.md`, this plan
**Effort:** M

- [x] RED: prove a crash after the transcript commit but before the assistant-message update replays the exact keyed terminal status, summary, and per-operation commit without another gateway call.
- [x] RED: prove a cancelled/budget terminal with an unresolved filesystem-tool lease cannot start the next turn or accept a late unmanifested mutation; prove agent-owned untracked paths survive handler/runtime recreation.
- [x] GREEN: persist a strict keyed operation receipt from pre-provider base commit count through terminal commit reconciliation; hydrate the model runtime's durable owned-path set; settle or fail closed on unknown mutation outcomes before continuation.
- [x] Verify: focused recovery/containment tests, MAC-6 owned suite, desktop type/lint, affected control/model suites, architecture checks, one final real-provider acceptance, max two reviews with exit zero Critical/Important.
- [x] Commit: `fix(desktop): durably reconcile local agent turns`

### Task MAC-6-FIX-3 [M2]: Single-writer local operation finalization

**Files:** Modify: `apps/desktop/src/zapp/runtime/local-session.ts`, its existing spec, `tasks/todo.md`, this plan
**Effort:** S

- [x] RED: pause operation A after its terminal transcript and before its receipt completes; prove distinct operation B cannot start, mutate the Git ref, or replace A's exact terminal result.
- [x] GREEN: hold one process-lifetime writer for each `(runId, taskId)` through session execution, commit reconciliation, and receipt completion; a crash releases the writer while the pending receipt remains recoverable by the same operation key.
- [x] GREEN: make receipt completion idempotently return an already-completed exact receipt before comparing caller-derived recovery data.
- [x] Verify: focused concurrent finalization/replay tests, MAC-6 owned suite, desktop type/lint, affected control/model suites, architecture checks, one final real-provider acceptance, max two reviews with exit zero Critical/Important.
- [x] Commit: `fix(desktop): serialize local agent finalization`

### Task MAC-7 [M4]: Docker runtime adapter

**Files:** Create: `apps/desktop/src/zapp/runtime/docker.ts`
**Effort:** M

- [x] Binding behavior (PRD §21.3): preserve Dyad Docker execution path, adapted to `WorkspaceRuntime` (`kind: "docker"`): container from `forge-node-base` public mirror image, project dir bind-mounted, exec via docker exec, same conformance suite; unavailable Docker → mode hidden with diagnostics link.
- [x] Commit: `feat(desktop): docker runtime mode`

### Task MAC-8 [M4]: Cloud mode client (builder + Mission Control parity)

**Files:** Create: `apps/desktop/src/zapp/builder-cloud/*`
**Effort:** L

- [ ] Binding behavior (PRD §21.3 cloud, §14.1 parity): cloud project window = shared builder components (conversation thread, preview via the zapp authenticated preview URL from WS-12/ADR-0023 in webview, Mission Control drawer; no Modal URL or provider token reaches the client) driven by the same SSE reducers as web; terminology/state identical (PRD §10.0.2); desktop adds: native menu actions (pause/resume run), dock badge for approvals.
- [ ] e2e: fixture event stream renders identically (snapshot parity test against web reducer outputs).
- [ ] Commit: `feat(desktop): cloud builder + mission control parity`

### Task MAC-9 [M4]: Git-based local↔cloud sync + conflict policy

**Files:** Create: `apps/desktop/src/zapp/sync/*`, `test/sync.spec.ts`
**Effort:** L

- [ ] Binding behavior (PRD §21.4): sync = commits only; uncommitted local changes → cloud execution blocked with three actions (Commit / Stash / Discard — explicit, no auto); pull/push against internal Git (user-scoped token via CP session); divergence → guided merge workflow (fetch, three-way merge UI listing conflicts, resolution commits) — **never last-writer-wins** (test: diverged fixture cannot reach a state where either side's commit is lost without an explicit merge commit).
- [ ] Commit: `feat(desktop): commit-boundary sync with guided merge`

### Task MAC-10 [M4]: Move local project to cloud

**Files:** Create: `apps/desktop/src/zapp/sync/promote.ts`
**Effort:** M

- [ ] Binding behavior (PRD §10.4): wizard: create cloud project → push local repo to internal Git → capability scan → cloud workspace boots → local project marked "linked" (subsequent work choice: local or cloud, synced per MAC-9); interrupted promotion resumable (idempotent by project fingerprint).
- [ ] Commit: `feat(desktop): local→cloud promotion wizard`

### Task MAC-11 [M5]: Notifications + auto-update

**Files:** Create: `apps/desktop/src/zapp/{notifications,updater}/*`
**Effort:** M

- [ ] Binding behavior: native notifications for `approval.requested`, `run.completed`, `deployment.updated(go_live|failed)` (opt-out per type in settings); auto-update: Squirrel feed from R2 (`desktop-updates/{channel}/`), channels stable/beta, signed updates only, release notes dialog; update failure never blocks launch. *(Phased implementation is complete; production run attachment remains blocked on MAC-8.)*
- [x] Commit: `feat(desktop): approval/run notifications + auto-update channel` (`5fc6741`)

### Task MAC-12 [M5]: Dyad local project migration

**Files:** Create: `apps/desktop/src/zapp/migrate-dyad.ts`
**Effort:** M

- [ ] Binding behavior (PRD §21.2): detect existing Dyad projects (Dyad home dir layout); import wizard: copy/adopt project folder → ensure git initialized (init + initial commit if absent) → register as zapp local project → offer cloud promotion (MAC-10); Dyad chat history import: best-effort read-only transcript archive attached to project (not merged into zapp conversation state). *(Phased implementation is complete; user-facing composition and promotion remain blocked on MAC-10.)*
- [x] Commit: `feat(desktop): dyad project migration path` (`1155e94`)

---

## Testing strategy
- WS-1 conformance kit reused across local/docker adapters (one suite, three runtimes incl. cloud via WS).
- Playwright-for-Electron smoke on CI mac runners per PR (MAC-3 suite + auth + cloud parity snapshots); signed-build E2E weekly.

## Scalability notes
- Desktop is a client; scale concerns are payload sizes (event virtualization shared with web) and update-feed bandwidth (R2).

## Security & tenancy notes
- Tokens in safeStorage only; local runtime enforces the same path guard + command policy (AR-5 policies bundled); local mode never receives other-tenant data (api-client org scoping identical to web); deep links validated (project id membership check before open).

## Execution log
- 2026-08-03: MAC-1 done (0fdefcc + fix 090c01a, audit fully Approved; dyad v1.9.0 @ 282591c, license boundary byte-verified, 2344 files reconciled to zero unexplained). 13 local_agent_* tests = MAC-6 behavioral spec; 51-file integration triage deferred (tracked in todo); pnpm-store ABI hazard → MAC-3.
- 2026-08-04: MAC-2 done (5190737 + fix 52df7a2, review fully Approved). Identity CI-asserted every build; updater neutralized until ZAPP_UPDATE_FEED (MAC-11 owns feed); signing env-gated (UNVERIFIED pending Developer ID cert — first real cert run is first execution). HANDOFFS: MAC-4 must re-host supabase/neon/pro OAuth returns (dead since dyad:// removal) + owns 5 of 6 remaining api.dyad.sh runtime endpoints; MAC-12: ~/dyad-apps is SHARED with any Dyad install (collision risk), not orphaned. Gatekeeper verify pending certs.
- 2026-08-04: MAC-3 done pending fix round (e050b01, review Approved; 7 specs all judged REAL). Suite location e2e-tests/ (plan path would have been collected by NOTHING — playwright testDir). CONTROLLER DECISION: wiring test:preserve into desktop.yml as an e2e-preserve job (an inert net earns no trust). Follow-ups: upstream monaco helper broken (replaceEditorContent targets aria-hidden ime-text-area) — blocks edit_code/editor_commit_menu specs, needs an upstream-facing fix task.
- 2026-08-04: MAC-3 done (e050b01 + fix 2816766 + budget e3493f5, fully Approved; 7 real specs, wired as CI job e2e-preserve). PLAN 09 M0 SCOPE COMPLETE (MAC-1/2/3). COST WATCH: a main push touching apps/desktop now spends both package-macos (90m budget) and e2e-preserve (45m) on macos-14 (10x-billed) — if it bites, move e2e-preserve to PR-only + nightly on main.
- 2026-08-10 MAC-4 done — Keychain-backed device auth is user-reachable through strict IPC and the TitleBar; production reachability required package, main-process, preload, and renderer composition edits beyond the original create-only file list.
- 2026-08-10 MAC-4-FIX-1 done — Pending logout revocations drain before re-auth, cached identity renders without awaiting the network, and serialized generation-fenced transitions prevent stale refresh resurrection or org rollback.
- 2026-08-10 MAC-5 done — Unified local/cloud dashboard uses strict IPC and generated public APIs; the separate MAC-5.5 task owns the pre-existing hybrid desktop-suite failures discovered during verification.
- 2026-08-10 MAC-5-FIX-1 done — Creation and list recovery are separate; ambiguous retries preserve the strict operation ID through the rendered recovery control.
- 2026-08-10 MAC-5.5 done — Restored strict auth and preload composition in the hybrid/package paths, verified the real Monaco helper 3/3, and preserved the 13 ADR-0002 local-agent RED specifications plus the bounded diagnostic remainder for MAC-6.
- 2026-08-10 MAC-6A done — Added the safe local runtime, packaged resumable AR-6 session state, exact changed-path commit refs, and fail-closed guarded writes; MAC-6 remains open for the public user-authenticated model-gateway/accounting and UI/mode join plus explicit commit application.
- 2026-08-10 MAC-6-FIX-1 BLOCKED — Containment, config-independent exact commits, terminal continuation, and truthful partial-commit reporting are focused-green (20/20), but the capped final review found missing keyed-result crash recovery, unresolved mutation-lease fencing, and durable owned-path hydration; provider acceptance was not consumed and MAC-6-FIX-2 owns the bounded closure.
- 2026-08-10 MAC-6-FIX-2 BLOCKED — Exact keyed receipts, nonterminal unknown-outcome fencing, and exact durable owned-path add/remove recovery are focused-green (22/22), but the capped final review found terminal Git/receipt finalization can still overlap a distinct operation; provider acceptance was not consumed and MAC-6-FIX-3 owns the single-writer closure.
- 2026-08-10 MAC-6-FIX-3 BLOCKED — Single-writer terminal finalization and authoritative receipt replay are locally green (25/25) with final review PASS, but the sole real Anthropic acceptance returned HTTP 401 `invalid x-api-key`; the task remains unchecked pending a valid provider credential.
- 2026-08-10 MAC-6 done — Closed the local WorkspaceRuntime/session join after the single final real-provider gate succeeded through the production OpenAI adapter (`gpt-5-mini`, 17 input/62 output tokens); desktop 25/25, PostgreSQL accounting 1/1, model-gateway 83/83, architecture 184/184, and affected static checks passed.
- 2026-08-10 MAC-6-FIX-1 done — The completed containment and terminal-continuation implementation passed the shared final MAC-6 verification and OpenAI provider gate; no additional provider call was made.
- 2026-08-10 MAC-6-FIX-2 done — The durable receipt, mutation fencing, and owned-path recovery implementation passed the shared final MAC-6 verification and OpenAI provider gate; no additional provider call was made.
- 2026-08-10 MAC-6-FIX-3 done — The single-writer finalization implementation passed 25/25 focused tests, final review remained PASS, and the one replacement real-provider acceptance completed through OpenAI without repeating the failed Anthropic call.
- 2026-08-11 MAC-7 BLOCKED — The required `forge-node-base` public OCI mirror does not exist in repository configuration or immutable image locks: `infra/modal/images.lock.json` contains only a Modal image id and Modal-local published name, while the preserved Dyad Docker path builds unrelated `node:22-alpine`. The binding create-only file list also cannot make the currently unconditional renderer selector hide Docker with a diagnostics link. Inventing a GHCR registry/tag or silently substituting the Dyad image would violate the locked image contract, so the task remains unchecked pending an approved public-image publication/configuration scope.
- 2026-08-12 MAC-7 done — Added the Docker WorkspaceRuntime over WS-17's digest-pinned public mirror, a project bind mount and docker-exec boundary, plus an IPC availability probe that hides unavailable Docker while retaining diagnostics; focused acceptance passed 7/7 and the previously undeclared fake-server type dependencies were made explicit so desktop typecheck passes.
- 2026-08-11 MAC-8 BLOCKED — The binding parity source does not exist yet: WEB-7 and WEB-9 remain unchecked, the current web Mission Control renders only `MissionControlEmpty`, and neither `packages/ui` nor another shared package exports the web conversation/Mission Control components or a shared SSE event reducer. A desktop-only reducer or copied state protocol would violate the task and Global Constraint, so the task remains unchecked pending those shared web surfaces.
- 2026-08-11 MAC-9 BLOCKED — API-first audit found no public session-authenticated internal-Git credential or sync API in the generated SDK; the only git-service credentials are internal service/repository-scoped boundaries. Without the prescribed user-scoped token, desktop cannot safely fetch/push or exercise the divergence/merge contract, so the task remains unchecked and no alternate credential path was introduced.
- 2026-08-11 MAC-10 BLOCKED — Promotion depends on MAC-9's missing authenticated Git push path: project creation and capability scan APIs exist, but the desktop cannot push the local repository to the new internal repository through any public SDK operation. The task remains unchecked; no direct git-service backdoor or local-only linked marker was added.
- 2026-08-12 MAC-11 BLOCKED — Commit `5fc6741` added schema-validated, deduplicated approval/run/deployment native-notification projection with server-backed per-type desktop preferences, stale-delivery rejection, and deep-link validation; it also replaced the legacy public-update host with failure-isolated signed Squirrel static feeds at `desktop-updates/{stable|beta}`. Focused acceptance is 26/26 with desktop lint/typecheck green; final production run attachment remains blocked on MAC-8, and the full desktop suite retains eight unrelated current-main failures in M4 chat-stream/compaction tests, so the tracker stays unchecked.
- 2026-08-12 MAC-12 BLOCKED — Commit `1155e94` added direct-child Dyad project detection, keyed copy/adopt and Git/registration boundaries, a bounded symlink-safe read-only transcript archive, and an optional cloud-promotion handoff. Focused acceptance is 9/9 with desktop main-process typecheck and file-scoped lint/format checks green; user-facing composition and promotion remain blocked on MAC-10/M4, so the tracker stays unchecked.
