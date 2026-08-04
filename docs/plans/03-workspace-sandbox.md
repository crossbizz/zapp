# Plan 03 — Workspace & Sandbox Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloud workspaces on Modal behind the `CloudSandboxProvider` contract: versioned images, in-sandbox workspace agent, authenticated preview proxy, lifecycle/checkpoint/recovery, secrets injection, and cost attribution — PRD §18, §26A.1.

**Architecture:** `services/sandbox-service` (port 4200) is the **only** Modal SDK consumer. Each workspace = one Modal Sandbox from a pinned image, running `sandbox/workspace-agent` (RPC over authenticated HTTP on :8877) and `sandbox/preview-proxy` (:8080, exposed via Modal connect tokens). Source of truth is internal Git (plan 06); volumes/snapshots are acceleration only. `packages/workspace-runtime` defines the runtime interface shared by cloud (this plan), local, and Docker (plan 09).

**Tech Stack:** Modal JS SDK (pinned), Fastify (service + workspace-agent), execa + node-pty (agent), http-proxy (preview proxy), tar/zstd (patch checkpoints), @zapp/contracts.

**Milestone:** M1 core (WS-1..WS-12), M2 hardening (WS-13..WS-15). **Depends on:** Plans 01, 02 (service auth, secrets), 06 (GIT-1..4 for tokens/clone). **Consumed by:** Plans 04, 05, 07, 09.

## Global Constraints

Master plan §Global Constraints, plus:
- No Modal type leaks: every public function of sandbox-service speaks `@zapp/contracts` types only.
- Sandboxes never receive: Modal credentials, control-plane DB URLs, service-token secrets, Stytch/Grafana/Flexprice keys. CI test greps injected env allowlist (WS-11).
- Image tags immutable (`forge-node-base:2026-08-15-a1b2c3`), pinned in config; never `latest`.
- Every sandbox tagged: `org_id, project_id, branch_id, run_id, task_id, purpose, environment` (PRD §18.4).
- Modal env separation: `zapp-dev`, `zapp-staging`, `zapp-prod`; apps `zapp-workspaces` and `zapp-browser-verify` per env.

## File structure owned

```text
services/sandbox-service/
  src/app.ts, src/server.ts
  src/provider/modal.ts          # CloudSandboxProvider impl (ONLY Modal SDK import site)
  src/provider/types.ts
  src/lifecycle/manager.ts       # state machine + reconciler
  src/lifecycle/reaper.ts        # idle + 24h replacement
  src/checkpoint/service.ts
  src/preview/tokens.ts
  src/secrets/injector.ts
  src/network/profiles.ts
  src/cost/recorder.ts
  src/routes/{workspaces,exec,files,preview}.ts   # /internal/* service-token only
sandbox/workspace-agent/         # ships INTO images
  src/main.ts, src/exec.ts, src/fs.ts, src/git.ts, src/health.ts
sandbox/preview-proxy/
  src/main.ts, src/inject/zapp-client.js, src/capture.ts
infra/modal/
  images/forge-node-base.ts      # image builder script (Modal SDK)
  images/forge-web-test.ts
  publish.ts                     # builds, tags, records digest in infra/modal/images.lock.json
packages/workspace-runtime/
  src/runtime.ts                 # WorkspaceRuntime interface (cloud/local/docker share)
```

---

### Task WS-1: `packages/workspace-runtime` interface

**Files:** Create: `packages/workspace-runtime/src/runtime.ts`, `test/runtime.test.ts`
**Interfaces produced (binding for plans 04, 05, 09):**

```ts
export interface WorkspaceRuntime {
  readonly kind: "cloud" | "local" | "docker";
  exec(input: { cmd: string; args: string[]; cwd?: string; env?: Record<string,string>;
    timeoutMs: number; pty?: boolean }): Promise<ExecResult>;          // { exitCode, stdout, stderr, durationMs, truncated }
  execStream(input: ExecInput): AsyncIterable<ExecChunk>;              // { stream: "stdout"|"stderr", data, at }
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  listFiles(path: string, opts?: { glob?: string; maxDepth?: number }): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  delete(path: string): Promise<void>;
  git(op: GitOp): Promise<GitResult>;                                  // status|diff|log|show|add_commit|push|checkout|branch|restore
  startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  health(): Promise<{ ok: boolean; details: string }>;
}
```

All paths resolved under workspace root; `..`/symlink escape → `PathViolationError` (PRD §16.3).
**Effort:** M

- [x] Steps: failing tests for a `MemoryWorkspaceRuntime` test double (path traversal rejected: `../etc/passwd`, `a/../../x`, symlink target outside root; exec timeout kills process; truncation at 1 MiB output with `truncated: true`) → implement double + path guard util `resolveInRoot(root, p)` → commit: `feat(workspace-runtime): shared runtime interface + path safety`

### Task WS-2: Modal images `forge-node-base` + `forge-web-test`

**Files:** Create: `infra/modal/images/forge-node-base.ts`, `forge-web-test.ts`, `publish.ts`, `images.lock.json`
**Effort:** L

- [ ] **Step 1:** `forge-node-base` per PRD §18.5: node 22 LTS, npm/pnpm/yarn (corepack), git + git-lfs, ripgrep, curl, jq, unzip, build-essential, python3 (node-gyp), dumb-init; bakes `sandbox/workspace-agent` and `sandbox/preview-proxy` builds at `/opt/zapp/{agent,proxy}` with a boot script `/opt/zapp/boot.sh` (starts agent on :8877 with one-time token from env `ZAPP_AGENT_TOKEN`, proxy on :8080); lightweight OTel exporter relaying sandbox telemetry to the sandbox-service collector endpoint (sandboxes never hold Grafana credentials — PRD §18.5 "OpenTelemetry collector or lightweight exporter").
- [ ] **Step 2:** `forge-web-test` extends base: Playwright + pinned Chromium + deps, axe-core CLI (accessibility), screenshot deps (fonts).
- [ ] **Step 3:** `publish.ts` builds both to all three Modal envs, tags `YYYY-MM-DD-{gitsha7}`, writes digests to `images.lock.json` (the only place services read tags from).
- [ ] **Step 4:** Verify: `pnpm modal:publish --env dev` then a smoke script creates a sandbox from the tag, `node --version` → `v22.*`, agent healthz responds. Commit: `feat(infra): versioned Modal base images with baked workspace agent`

### Task WS-3: workspace-agent daemon

**Files:** Create: `sandbox/workspace-agent/src/{main,exec,fs,git,health}.ts`, `test/agent.test.ts`
**Interfaces produced:** HTTP API on :8877 (bearer = `ZAPP_AGENT_TOKEN`, constant-time compare): `POST /exec` (+ `?stream=1` chunked NDJSON), `POST /exec/:pid/kill`, `GET/PUT /files?path=`, `GET /files/list`, `POST /git`, `GET /healthz` (also reports dev-server port probe), `GET /metrics` (cpu/mem snapshot for cost sampling). Implements the WS-1 semantics server-side (path guard at agent level too — defense in depth).
**Effort:** L

- [x] Steps: failing tests run the agent locally against a temp dir (exec `echo hi` streams chunk; `pty:true` allocates tty (`test -t 1` exits 0); file write→read round-trip; git init/commit/status ops; wrong token → 401; path escape → 400) → implement with execa/node-pty → commit: `feat(sandbox): workspace-agent RPC daemon`

### Task WS-4: Modal provider — create/attach/exec/terminate

**Files:** Create: `services/sandbox-service/src/provider/modal.ts`, `src/app.ts`, `src/routes/workspaces.ts`, `test/integration/modal-provider.test.ts` (env-gated `MODAL_TOKEN_ID`)
**Interfaces produced:** `ModalSandboxProvider implements CloudSandboxProvider` (FND-4): `createWorkspace` (image from lock file, resources from profile, tags, env allowlist, boot cmd, readiness = agent healthz poll ≤ 30 s p95 warm), `attachWorkspace` (by provider id — reattach after service restart), `terminateWorkspace`, `exec`/`readFile`/`writeFile` proxied through workspace-agent client, `getStatus`. Service routes `/internal/workspaces*` map CP-9 calls onto provider + `workspaces` table rows.
**Effort:** XL → split at execution into 4a (create/terminate/status + DB rows), 4b (agent client proxying), 4c (attach/reattach recovery). **[expand-at-execution]** for 4b/4c.

- [ ] **Step (4a) failing integration test:** create workspace (dev env, small profile) → row status walks `requested→provisioning→started→ready`; `getStatus` matches Modal; terminate → `terminated`, Modal sandbox gone. Idempotent create by `(runId, taskId, purpose)` key returns existing.
- [ ] Commit(s): `feat(sandbox-service): Modal workspace create/status/terminate`, `... agent proxy exec/files`, `... reattach recovery`

### Task WS-5: Git in sandbox

**Files:** Create: `src/provider/git-bootstrap.ts`, `test/integration/git-clone.test.ts`
**Effort:** M

- [ ] Binding behavior: on workspace create with `branchId`: mint short-lived repo-scoped token from git-service (GIT-3), clone `https://x-access-token:{token}@forgejo…/org_{id}/proj_{id}.git` at branch, configure `user.name="zapp-agent"`, `user.email="agent@zapp.build"`, store no credentials on disk after clone (`credential.helper=""`, token only in clone URL of initial fetch; subsequent pushes mint fresh tokens via agent `/git` op that requests token from sandbox-service — sandbox never holds long-lived creds).
- [ ] Failing test: create→clone→edit→commit→push round-trip lands in Forgejo; token expired (TTL 300 s) push fails then succeeds after re-mint.
- [ ] Commit: `feat(sandbox-service): scoped-token git clone/push bootstrap`

### Task WS-6: Lifecycle manager + reconciler

**Files:** Create: `src/lifecycle/manager.ts`, `src/lifecycle/reaper.ts`, `test/lifecycle.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §18.9): state machine exactly `requested→provisioning→started→ready→active→checkpointing→idle→terminated` with legal-transition table; failure handling for each listed case (provider creation failure → retry 3× jittered then `failed` + event; readiness failure → capture boot logs artifact; OOM/unexpected termination → mark `terminated`, flag `abnormal`, orchestrator recovers via checkpoint; expired sandbox id on attach → fall back to restore path); reaper: idle 15 min (interactive) / 30 min (autonomous) → checkpoint→terminate; hard replace ≥ 23 h uptime (checkpoint→terminate→recreate on demand — never hit Modal's 24 h wall); reconciler cron compares DB rows vs Modal list (by tags) and repairs drift both directions (orphan Modal sandbox → terminate + alert; stale DB `active` row → mark terminated).
- [ ] Failing tests: transition table (illegal transition throws `InvalidTransition`); reaper picks correct timeout by purpose; reconciler terminates orphan (fake provider).
- [ ] Commit: `feat(sandbox-service): lifecycle state machine, idle reaper, drift reconciler`

### Task WS-7: Checkpoints & restore

**Files:** Create: `src/checkpoint/service.ts`, `test/integration/checkpoint.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §18.6/§18.8): `checkpoint(workspaceId, opts)`: (1) commit+push any staged task state if a task boundary (caller decides), (2) uncommitted changes → `git diff` + untracked tar → zstd → **encrypted** (CP-7 crypto) patch artifact in R2, (3) optional Modal filesystem snapshot recorded with TTL per class (active 30 d / diagnostic 7 d / evidence 30 d); `restore(projectId, branchId, checkpointRef?)`: prefer snapshot if fresh, else clone from Git + apply patch artifact; **restore must succeed with zero snapshots available** (test deletes snapshot first — PRD §18.8 "no workflow may depend exclusively on snapshot availability").
- [ ] Failing integration test: create ws → write uncommitted file → checkpoint → terminate → restore → file present; delete snapshot → restore again → file still present (via patch artifact).
- [ ] Commit: `feat(sandbox-service): git+patch+snapshot checkpoints with snapshot-free restore`

### Task WS-8: Resource profiles + cost recorder

**Files:** Create: `src/cost/recorder.ts`, `src/provider/profiles.ts`, `test/cost.test.ts`
**Effort:** M

- [ ] Binding behavior: profiles exactly PRD §18.10 table (small 0.5/2 cpu 1/4 GiB, standard 1/4 2/8, large 2/8 4/16); recorder samples agent `/metrics` every 30 s while active, on terminate writes `usage_ledger` rows: `sandbox_cpu_seconds` and `sandbox_mem_gib_seconds` = max(requested, observed) per Modal billing model (PRD §18.14), attributed org/project/run/task; pricing multipliers from config file `config/pricing.json`.
- [ ] Failing tests: ledger rows computed from fake samples match hand-computed values; attribution fields present.
- [ ] Commit: `feat(sandbox-service): resource profiles + per-sandbox cost attribution`

### Task WS-9: Volumes & dependency caches

**Files:** Create: `src/provider/volumes.ts`
**Effort:** M

- [ ] Binding behavior (PRD §18.7): one project-scoped Volume `vol-proj_{id}` mounted at `/cache` (pnpm store `PNPM_STORE_DIR=/cache/pnpm`, playwright browsers `/cache/ms-playwright` on web-test image); no cross-org shared writable volumes (name embeds project id; creation checks project org); concurrent-writer guard: branch working dirs under `/workspace/{branchId}` with advisory lock file — second writer for same branch → `BranchLockedError` (PRD §18.7 "concurrent writers prohibited").
- [ ] Test: second create for same branch while first active → 409; different branch OK.
- [ ] Commit: `feat(sandbox-service): project-scoped cache volumes + branch write locks`

### Task WS-10: preview-proxy (in-sandbox)

**Files:** Create: `sandbox/preview-proxy/src/{main,capture}.ts`, `src/inject/zapp-client.js`, `test/proxy.test.ts`
**Interfaces produced (binding for WEB/VF plans):** proxy on :8080 → app port from execution contract (or auto-probe 3000/5173/4321/8000): reverse proxy + WebSocket forwarding; HTML responses get `<script src="/__zapp/client.js">` injected before `</head>`; `zapp-client.js` implements: console capture (log/warn/error with stack), window.onerror/unhandledrejection capture, fetch/XHR metadata capture (url, method, status, duration — **no bodies**), route-change events (history API hook), element selection mode (hover outline + click → `{ selector, computedRole, text, boundingBox, componentHint }` via postMessage to parent), screenshot trigger relay; proxy endpoints: `GET /__zapp/healthz`, `GET /__zapp/events` (SSE of captured entries), `POST /__zapp/screenshot` (via CDP to headless-capable page — in web-test image only; base image returns 501); heartbeat ping to sandbox-service every 30 s.
**Effort:** L

- [ ] Failing tests (local, proxying a fixture express app): HTML injected exactly once incl. streamed responses; WS echo forwarded; console.error in fixture page appears on `/__zapp/events` (jsdom or playwright-driven); fetch metadata captured without body; non-HTML (JSON, images) untouched byte-for-byte.
- [ ] Commit: `feat(sandbox): preview proxy with capture + selection client`

### Task WS-11: Secrets injection + network profiles + redaction

**Files:** Create: `src/secrets/injector.ts`, `src/network/profiles.ts`, `test/injection.test.ts`
**Effort:** M

- [ ] Binding behavior: on workspace create, sandbox-service (allowlisted) calls CP-7 decrypt for the project+environment scope, injects as env vars into the app process env **only** (agent env carries names list for redaction, never values in agent config file); env allowlist test: assert injected env ⊆ {user secrets, ZAPP_AGENT_TOKEN, PNPM_STORE_DIR, contract-declared vars} — no `MODAL_*`, `DATABASE_URL`, `SERVICE_TOKEN_*`, `STYTCH_*`, `GRAFANA_*`, `FLEXPRICE_*` (Global Constraint 5 as executable test); network profiles (PRD §18.11): `dependency_install` (registries+git hosts+configured integrations), `build_test` (integrations only), `restricted_verification` (deny-all or strict allowlist) — applied via Modal network policy where supported, and **always** logged as defense-in-depth policy record (PRD: treat as defense in depth); redaction: workspace-agent output pipeline scrubs via `redactSecrets` registry before anything leaves the sandbox-service boundary (test: `echo $STRIPE_KEY` output shows `[secret:STRIPE_KEY]` in stored/tool output).
- [ ] Commit: `feat(sandbox-service): scoped secret injection, network profiles, output redaction`

### Task WS-12: Preview access tokens + share records

**Files:** Create: `src/preview/tokens.ts`, `src/routes/preview.ts`, `test/preview-auth.test.ts`
**Effort:** M

- [ ] Binding behavior (PRD §18.11/§18.13): `createPreview(workspaceId)` → Modal connect-token URL wrapping :8080, token metadata `{ userId, projectId, expiresAt }`; preview URLs are never raw public tunnels; share links only via share record (`POST /v1/workspaces/:id/preview/shares` → { url, expiresAt, policy: "org" | "anyone_with_link" }, revocable `DELETE`, listed in project settings); revocation kills token server-side ≤ 10 s.
- [ ] Failing tests: preview URL without valid token → 401 (Modal-level asserted in env-gated test; policy-level in unit); revoked share → 401 within 10 s.
- [ ] Commit: `feat(sandbox-service): authenticated previews + revocable share records`

### Task WS-13 [M2]: Dev-server supervisor + log streaming

**Files:** Create: `src/routes/exec.ts` additions, workspace-agent `src/devserver.ts`
**Effort:** M. **[expand-at-execution]**

Binding behavior: `startDevServer(contract)` runs `develop.command` under supervisor (restart on crash ≤ 3×/5 min then `preview.failed` event), readiness = TCP+HTTP probe on contract port, wires proxy target; `restart_dev_server` tool support; log ring buffer (10 MiB) + `read_logs` since-cursor API; emits `preview.starting/ready/failed` events via CP-13.

### Task WS-14 [M2]: Modal integration test suite (real dev env)

**Files:** Create: `test/integration/modal-e2e.test.ts`, CI nightly workflow
**Effort:** M

- [ ] Nightly (not per-PR) against `zapp-dev` Modal env: full journey — create(std profile) → clone template → `pnpm install` (cache volume speeds 2nd run — assert ≥ 40% faster) → dev server → preview proxy healthz through connect URL → checkpoint → kill sandbox via Modal API directly (simulate OOM) → restore → dev server again → terminate. Alert on failure (Grafana Alerting → OnCall). Pins SDK; this suite is the Modal-SDK-churn early-warning (master risk table).
- [ ] Commit: `test(sandbox-service): nightly Modal E2E journey`

### Task WS-15 [M2]: Runaway-compute governor

**Files:** Create: `src/lifecycle/governor.ts`
**Effort:** M. **[expand-at-execution]**

Binding behavior: global + per-org concurrent-sandbox caps from plan config (OPS-3 exposes limits); exceeding → 429 `sandbox_quota_exceeded` with queue-position hint; support kill-switch `POST /internal/orgs/:id/terminate-all` (audited, used by OPS-17 console); per-run wall-clock budget enforcement (default interactive 4 h / autonomous phase 8 h per PRD §18.9).

---

## Testing strategy
- Unit vs fakes for state machines/policies; env-gated integration against real Modal dev env (WS-4, WS-5, WS-7, WS-12); nightly E2E (WS-14).
- The env-allowlist test (WS-11) and preview-auth test (WS-12) are permanent security suite members (referenced by OPS-12).

## Scalability notes
- Reattach-by-id + stateless service → horizontal replicas; reconciler is leader-elected (Redis lock).
- Warm image + volume caches target: sandbox ready p95 < 30 s, template preview < 2 min p50 (PRD §36.2) — measured by WS-14 and OPS-9 dashboards.

## Security & tenancy notes
- This plan implements Global Constraints 1, 5, 6, 8 as **tests**, not conventions. Sandbox isolation abuse tests (fork bomb, OOM, egress attempts) live in OPS-12 and run against this service.

## Execution log

- 2026-08-04 WS-1 done — shared runtime interface, path guard, and memory test double added.
- 2026-08-04 WS-2 BLOCKED — Step 1 requires baking the real `sandbox/workspace-agent` and `sandbox/preview-proxy` builds, but those source trees are produced by WS-3 and WS-10 and do not exist yet. No placeholder image content is permitted; complete WS-3 and WS-10, then resume WS-2. Modal dev credentials are available and are not the blocker.
- 2026-08-04 WS-3 done — authenticated workspace-agent RPC daemon added with strict schemas, path and git guards, real PTY execution, bounded streaming, and child reaping.
