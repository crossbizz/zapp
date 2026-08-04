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

- [ ] **Step 1:** Vendor Dyad at a pinned commit (recorded in ADR + NOTICE); remove `src/pro` directory; build until clean: stub/no-op every Pro import site (each site marked `// zapp: pro-removed`), feature-flag Pro-only UI off.
- [ ] **Step 2:** Prove: `pnpm --filter desktop start` launches; create/open a local Vite template project; chat panel renders (model calls may be non-functional until MAC-6 — UI boots is the bar); `pnpm --filter desktop make` produces a signed-less dev .app.
- [ ] **Step 3:** FND-9 lint green on the fork (no pro imports); NOTICE updated.
- [ ] Commit: `feat(desktop): dyad fork building without src/pro (PRD §38.1 exit)`

### Task MAC-2: Rebrand + packaging/signing/notarization CI

**Files:** Modify: `apps/desktop/forge.config.ts`, icons/assets, `.github/workflows/desktop.yml`
**Effort:** M

- [ ] Binding behavior: identity `build.zapp.desktop`, product name "zapp", protocol `zapp://` (auth callback + deep links `zapp://project/{id}`), icons/DMG assets; CI: macOS runner make → codesign (Developer ID cert in secrets) → notarytool staple → artifact upload; unsigned dev builds for PRs.
- [ ] Verify: notarized build passes Gatekeeper on a clean machine (`spctl -a -vv`).
- [ ] Commit: `feat(desktop): zapp identity + signed/notarized packaging pipeline`

### Task MAC-3: Preserve-list regression suite

**Files:** Create: `apps/desktop/test/preserve.spec.ts` (Playwright-for-Electron smoke set)
**Effort:** M

- [ ] Binding behavior: automated smoke for the PRD §21.1 preserve list that exists in Dyad today: local file access, terminal/PTY opens, bundled Git operations, local process management (dev server start/stop), local preview renders, window/protocol handling. Each = one spec; Docker specs env-gated to runners with Docker.
- [ ] Commit: `test(desktop): dyad capability preservation suite`

### Task MAC-4 [M2]: Platform auth + Keychain

**Files:** Create: `apps/desktop/src/zapp/auth/*`
**Effort:** M

- [ ] Binding behavior: device/PKCE flow (CP-2): app opens browser to hosted auth → `zapp://auth/callback` → exchanges for tokens → refresh token in `safeStorage` (Keychain-backed), access token memory-only; sign-out purges; org selector after auth; offline: cached identity renders, cloud features disabled with clear state.
- [ ] Failing tests: token persisted encrypted (file content ≠ plaintext token); relaunch restores session without re-auth; revoked refresh → clean re-login prompt.
- [ ] Commit: `feat(desktop): platform auth with keychain-backed sessions`

### Task MAC-5 [M2]: Cloud dashboard + shared client

**Files:** Create: `apps/desktop/src/zapp/{dashboard,project-list}/*`
**Effort:** M

- [ ] Binding behavior: project list/dashboard via api-client (same read models as WEB-4); open cloud project → builder window in cloud mode (MAC-8); create-new routes through home-style composer (WEB-3 pattern, shared components); local projects section lists Dyad-style local folders side-by-side with cloud projects (source badge: Local / Cloud).
- [ ] Commit: `feat(desktop): unified local+cloud project dashboard`

### Task MAC-6 [M2]: Local runtime adapter

**Files:** Create: `apps/desktop/src/zapp/runtime/local.ts`, `test/local-runtime.spec.ts`
**Effort:** L

- [ ] Binding behavior (PRD §21.3 local mode): implement `WorkspaceRuntime` (WS-1 interface, `kind: "local"`) in the Electron main process: exec via node-pty/execa rooted at project dir (same path-guard util), fs ops, git via bundled git, dev-server supervisor with port detection; agent runs execute **locally**: a desktop-hosted session loop (AR-6 packaged for local: model calls still via platform model-gateway over HTTPS — Global Constraint 2 holds; tools bound to local runtime); run state persisted to local SQLite so app restart resumes conversation (no P0 guarantee of durable autonomous execution offline — Autonomous mode requires cloud, enforced: mode picker disables it in local mode with "Move to cloud" hint, PRD §21.3).
- [ ] Failing tests: WS-1 conformance suite (shared test kit from WS-1 runs against local adapter — path escape, timeout, truncation); local chat edit round-trip commits to local git.
- [ ] Commit: `feat(desktop): local WorkspaceRuntime + local agent sessions`

### Task MAC-7 [M4]: Docker runtime adapter

**Files:** Create: `apps/desktop/src/zapp/runtime/docker.ts`
**Effort:** M

- [ ] Binding behavior (PRD §21.3): preserve Dyad Docker execution path, adapted to `WorkspaceRuntime` (`kind: "docker"`): container from `forge-node-base` public mirror image, project dir bind-mounted, exec via docker exec, same conformance suite; unavailable Docker → mode hidden with diagnostics link.
- [ ] Commit: `feat(desktop): docker runtime mode`

### Task MAC-8 [M4]: Cloud mode client (builder + Mission Control parity)

**Files:** Create: `apps/desktop/src/zapp/builder-cloud/*`
**Effort:** L

- [ ] Binding behavior (PRD §21.3 cloud, §14.1 parity): cloud project window = shared builder components (conversation thread, preview via Modal connect URL in webview, Mission Control drawer) driven by the same SSE reducers as web; terminology/state identical (PRD §10.0.2); desktop adds: native menu actions (pause/resume run), dock badge for approvals.
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

- [ ] Binding behavior: native notifications for `approval.requested`, `run.completed`, `deployment.updated(go_live|failed)` (opt-out per type in settings); auto-update: Squirrel feed from R2 (`desktop-updates/{channel}/`), channels stable/beta, signed updates only, release notes dialog; update failure never blocks launch.
- [ ] Commit: `feat(desktop): approval/run notifications + auto-update channel`

### Task MAC-12 [M5]: Dyad local project migration

**Files:** Create: `apps/desktop/src/zapp/migrate-dyad.ts`
**Effort:** M

- [ ] Binding behavior (PRD §21.2): detect existing Dyad projects (Dyad home dir layout); import wizard: copy/adopt project folder → ensure git initialized (init + initial commit if absent) → register as zapp local project → offer cloud promotion (MAC-10); Dyad chat history import: best-effort read-only transcript archive attached to project (not merged into zapp conversation state).
- [ ] Commit: `feat(desktop): dyad project migration path`

---

## Testing strategy
- WS-1 conformance kit reused across local/docker adapters (one suite, three runtimes incl. cloud via WS).
- Playwright-for-Electron smoke on CI mac runners per PR (MAC-3 suite + auth + cloud parity snapshots); signed-build E2E weekly.

## Scalability notes
- Desktop is a client; scale concerns are payload sizes (event virtualization shared with web) and update-feed bandwidth (R2).

## Security & tenancy notes
- Tokens in safeStorage only; local runtime enforces the same path guard + command policy (AR-5 policies bundled); local mode never receives other-tenant data (api-client org scoping identical to web); deep links validated (project id membership check before open).

## Execution log

- (empty)
