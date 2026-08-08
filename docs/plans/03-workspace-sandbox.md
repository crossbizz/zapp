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
  package.json, tsconfig.json
  src/app.ts, src/server.ts
  src/provider/modal.ts          # image publisher + CloudSandboxProvider impl (ONLY Modal SDK import site)
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
  images/forge-node-base.ts      # provider-neutral image recipe
  images/forge-web-test.ts
  publish.ts                     # orchestrates provider facade, records digest in images.lock.json
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
    timeoutMs: number; pty?: boolean }): Promise<ExecResult>;          // { exitCode, stdout, stderr, durationMs, truncated, terminationReason?: "timeout" }
  execStream(input: ExecInput): AsyncIterable<ExecChunk>;              // { stream: "stdout"|"stderr", data, at }
  readFile(path: string): Promise<Uint8Array>;
  readFileForUpdate(path: string): Promise<{ data: Uint8Array; revision: string }>; // fails closed unless the provider can enforce revision CAS across every mutation path
  writeFile(path: string, data: Uint8Array): Promise<void>;            // participates in the atomic commit serialization boundary
  writeFilesAtomically(files: readonly { path: string; data: Uint8Array; expectedRevision?: string }[]): Promise<void>; // guarded batches atomically validate all revisions and commit, or conflict with zero target writes
  search(input: { pattern: string; path: string; glob?: string; fixedStrings?: boolean; ignoreCase?: boolean }): Promise<ExecResult>;
  listFiles(path: string, opts?: { glob?: string; maxDepth?: number }): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStat>;
  delete(path: string): Promise<void>;
  deleteFile(path: string): Promise<void>;                             // nonrecursive; directories reject; ENOENT succeeds
  renameFile(input: { source: string; destination: string; overwrite: "replace" }): Promise<void>; // same-object aliases reject
  git(op: GitOp): Promise<GitResult>;                                  // status|diff|log|show|add_commit|push|checkout|branch|restore|merge|revert
  startDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  restartDevServer(contract: ExecutionContract): Promise<{ port: number; pid: number }>;
  health(): Promise<{ ok: boolean; details: string }>;
}
```

All paths resolved under workspace root; `..`/symlink escape → `PathViolationError` (PRD §16.3).
Production/cloud `search`, `deleteFile`, and `renameFile` are single descriptor-relative
operations under ADR-0006 and ADR-0013; callers must not split validation from use.
**Effort:** M

- [x] Steps: failing tests for a `MemoryWorkspaceRuntime` test double (path traversal rejected: `../etc/passwd`, `a/../../x`, symlink target outside root; exec timeout kills process; truncation at 1 MiB output with `truncated: true`) → implement double + path guard util `resolveInRoot(root, p)` → commit: `feat(workspace-runtime): shared runtime interface + path safety`

### Task WS-2: Modal images `forge-node-base` + `forge-web-test`

**Files:** Create: `infra/modal/images/forge-node-base.ts`, `forge-web-test.ts`, `publish.ts`, `images.lock.json`; per ADR-0019, create the minimal `services/sandbox-service` package scaffolding and `src/provider/modal.ts` as the only Modal SDK import site, plus tests for the recipes and publication transaction
**Effort:** L

- [x] **Step 1:** `forge-node-base` per PRD §18.5: node 22 LTS, npm/pnpm/yarn (corepack), git + git-lfs, ripgrep, curl, jq, unzip, build-essential, python3 (node-gyp), dumb-init; bakes `sandbox/workspace-agent` and `sandbox/preview-proxy` builds at `/opt/zapp/{agent,proxy}` with a boot script `/opt/zapp/boot.sh` (starts agent on :8877 with one-time token from env `ZAPP_AGENT_TOKEN`, proxy on :8080); lightweight OTel exporter relaying sandbox telemetry to the sandbox-service collector endpoint (sandboxes never hold Grafana credentials — PRD §18.5 "OpenTelemetry collector or lightweight exporter").
- [x] **Step 2:** `forge-web-test` extends base: Playwright + pinned Chromium + deps, axe-core CLI (accessibility), screenshot deps (fonts).
- [x] **Step 3:** `publish.ts` builds both to all three Modal envs, tags `YYYY-MM-DD-{gitsha7}`, writes digests to `images.lock.json` (the only place services read tags from).
- [x] **Step 4:** Verify: `pnpm modal:publish --env dev` then a smoke script creates a VM Sandbox from the tag with the pinned SDK/runtime option, `node --version` → `v22.*`, agent healthz responds, and ADR-0007's cgroup create/join/kill/`populated 0` capability probe passes. The smoke must also verify every P0 feature consumed by the runtime (volumes, filesystem snapshots, tunnels/connect tokens, and readiness probes); unsupported capability is a visible blocker, never a downgrade. Commit: `feat(infra): versioned Modal base images with baked workspace agent`

### Task WS-3: workspace-agent daemon

**Files:** Create: `sandbox/workspace-agent/src/{main,exec,fs,git,health}.ts`, `test/agent.test.ts`
**Interfaces produced:** HTTP API on :8877 (bearer = `ZAPP_AGENT_TOKEN`, constant-time compare): `POST /exec` (+ `?stream=1` chunked NDJSON), `POST /exec/:pid/kill`, `GET/PUT /files?path=`, `GET /files/list`, `POST /git`, `GET /healthz` (also reports dev-server ownership evidence), `GET /metrics` (cpu/mem snapshot for cost sampling). The WS-1 additions use these exact authenticated, Zod-strict protocol shapes:

```ts
POST /files/atomic-write
  body: { files: Array<{ path: string; dataBase64: string; expectedRevision?: string }> }
  200:  { ok: true }
GET /files/update-snapshot?path=<percent-encoded workspace-relative path>
  200:  { dataBase64: string; revision: string }
POST /search
  body: { pattern: string; path: string; glob?: string; fixedStrings?: boolean; ignoreCase?: boolean }
  200:  ExecResult
DELETE /files?path=<percent-encoded workspace-relative path>
  200:  { ok: true; alreadyAbsent: boolean }
POST /files/rename
  body: { source: string; destination: string; overwrite: "replace" }
  200:  { ok: true }
```

Every filesystem operation is descriptor-relative under the pinned workspace-root descriptor per ADR-0006/ADR-0013: walk parents without following links, reject leaf symlinks for atomic writes, stage/commit/rollback through pinned parent descriptors, run allowlisted `rg` against an inherited pinned target descriptor, delete with nonrecursive `unlinkat` semantics (`ENOENT` succeeds; directories reject), and rename with descriptor-relative atomic replace. Atomic-write preflight rejects lexical/canonical/same-inode duplicates plus initially absent names that the canonical parent filesystem treats as case-folding or Unicode-normalization aliases; capability probing/reservation occurs only in a hidden per-parent directory, creates none of the requested targets, and is cleaned before staging. Implements the WS-1 semantics server-side (the agent-level path guard remains defense in depth).

Atomic-write commits and ordinary file writes are serialized together. A guarded
snapshot and batch use an opaque revision only when the backing provider offers an
atomic revision CAS whose revision domain observes every mutation path, including
workspace-agent exec/Git activity, other runtime instances, editors, and provider
operations. The provider validates every expected revision and commits the complete
batch at one linearization point; a mismatch returns the stable typed atomic-write
conflict with zero target writes. Descriptor-relative byte comparison followed by
rename, in-process queues, and advisory locks do not satisfy this contract. WS-3 must
return the typed conflict for guarded snapshot/write requests when its backing
provider cannot enforce the CAS. The strict revision fields exist only for guarded
batch writes and do not expose a generic filesystem operation.

**Blocking guarded-write acceptance:** fail-closed behavior is the safe unsupported
fallback, not proof of production patch capability. WS-3/WS-4 cannot be marked
complete until at least one production cloud runtime proves successful guarded patch
commit plus deterministic final-window conflict/zero-write preservation while its
revision domain covers exec, Git, editor, other-runtime, and provider mutations. If
the selected provider exposes no such primitive, record WS-3 as blocked and obtain an
approved architecture decision; do not substitute compare-then-rename or a
non-compulsory lock.
**Effort:** L

- [ ] Steps: failing tests run the agent locally against a temp dir (exec `echo hi` streams chunk; `pty:true` allocates tty (`test -t 1` exits 0); file write→read round-trip; git init/commit/status ops; wrong token → 401; path escape → 400) and run the shared `WorkspaceRuntime` conformance cases for unguarded `writeFilesAtomically`, search, delete, rename, and unsupported guarded-write fail-closed behavior against both `MemoryWorkspaceRuntime` and the local HTTP workspace-agent adapter; the blocking production-provider suite separately proves guarded revision CAS success and final-window conflict with zero target writes → implement with execa/node-pty → commit: `feat(sandbox): workspace-agent RPC daemon`

### Task WS-4: Modal provider — create/attach/exec/terminate

**Files:** Create: `services/sandbox-service/src/provider/modal.ts`, `src/app.ts`, `src/routes/workspaces.ts`, `test/integration/modal-provider.test.ts` (env-gated `MODAL_TOKEN_ID`)
**Interfaces produced:** `ModalSandboxProvider implements CloudSandboxProvider` (FND-4): `createWorkspace` (image from lock file, resources from profile, tags, env allowlist, boot cmd, readiness = agent healthz poll ≤ 30 s p95 warm), `attachWorkspace` (by provider id — reattach after service restart), `terminateWorkspace`, `exec`/`readFile`/`readFileForUpdate`/`writeFile`/`writeFilesAtomically`/`search`/`deleteFile`/`renameFile`/`startDevServer`/`restartDevServer` proxied through the exact WS-3 workspace-agent routes, `getStatus`. The provider client accepts only the WS-1 typed inputs, base64-encodes atomic bytes, validates every strict response before returning, and never exposes a generic agent URL, host path, filesystem flag, or arbitrary git/process escape hatch. Service routes `/internal/workspaces*` map CP-9 calls onto provider + `workspaces` table rows.

The service-token-authenticated cloud-runtime routes map one-for-one to WS-3 and preserve its strict bodies/responses: `GET /internal/workspaces/:workspaceId/files/update-snapshot?path=`, `POST /internal/workspaces/:workspaceId/files/atomic-write`, `POST /internal/workspaces/:workspaceId/search`, `DELETE /internal/workspaces/:workspaceId/files?path=`, `POST /internal/workspaces/:workspaceId/files/rename`, `POST /internal/workspaces/:workspaceId/dev-server/start`, and `POST /internal/workspaces/:workspaceId/dev-server/restart`. The two dev-server routes accept exactly `{ contract: ExecutionContract }` and return the exact WS-3 supervisor response. The service resolves `workspaceId` to an attached provider sandbox; callers cannot supply provider IDs or agent origins. Guarded snapshot/write routes return the typed atomic-write conflict unless the attached provider supplies the revision CAS bound by WS-1.
**Effort:** XL → split at execution into 4a (create/terminate/status + DB rows), 4b (agent client proxying), 4c (attach/reattach recovery). **[expand-at-execution]** for 4b/4c.

- [ ] **Step (4a) failing integration test:** create workspace (dev env, small profile) → row status walks `requested→provisioning→started→ready`; `getStatus` matches Modal; terminate → `terminated`, Modal sandbox gone. Idempotent create by `(runId, taskId, purpose)` key returns existing.
- [ ] **Step (4b) failing proxy/conformance tests:** validate each strict WS-3 request/response through the attached provider; run the shared env-gated Modal conformance suite for atomic write (including guarded revision-CAS success, final-window conflict with zero target writes and preserved concurrent content, alias, leaf-symlink, rollback, cleanup, and mode guarantees), search confinement/zero matches, repeated file-only deletion, rename replace/same-object rejection, and both managed dev-server start and restart. The guarded suite must exercise mutation through exec, Git, another runtime attachment, and provider operations; any uncovered writer leaves WS-4 blocked rather than weakening the contract. Start/restart responses must carry identical supervisor ownership/readiness evidence; the Modal and local HTTP adapters both reject an unrelated listener as readiness.
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

- [x] Failing tests (local, proxying a fixture express app): HTML injected exactly once incl. streamed responses; WS echo forwarded; console.error in fixture page appears on `/__zapp/events` (jsdom or playwright-driven); fetch metadata captured without body; non-HTML (JSON, images) untouched byte-for-byte.
- [x] Commit: `feat(sandbox): preview proxy with capture + selection client`
- [x] **Re-scoped by ADR-0017 (unblocks WS-2).** Do NOT hand-parse HTML — `task/WS-10` capped on unquoted `src` + `<style>` raw-text. Inject the `<script>` before `</head>` with a streaming HTML rewriter (`lol-html`/`HTMLRewriter` or `parse5`); non-HTML passes byte-for-byte untouched. The rewriter is the correctness boundary; there is no bespoke scanner to make complete.

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

Binding behavior: `startDevServer(contract)` runs `develop.command` under supervisor (restart on crash ≤ 3×/5 min then `preview.failed` event), wires proxy target; `restart_dev_server` tool support; log ring buffer (10 MiB) + `read_logs` since-cursor API; emits `preview.starting/ready/failed` events via CP-13. The authenticated workspace-agent routes are exactly:

```ts
POST /dev-server/start   body: { contract: ExecutionContract }
POST /dev-server/restart body: { contract: ExecutionContract }
200 response for either: { port: number; pid: number; supervisorId: string; ownership: "process" | "process_group" }
GET /healthz
  200: { ok: true; details: string; devServer: null | { port: number; pid: number; supervisorId: string; owned: boolean; httpReady: boolean } }
```

Sandbox-service exposes the same strict requests/responses as both `POST /internal/workspaces/:workspaceId/dev-server/start` and `POST /internal/workspaces/:workspaceId/dev-server/restart`, mapping each one-for-one through the provider/client to `/dev-server/start` and `/dev-server/restart` respectively. It resolves the attributed workspace to its attached provider sandbox without accepting a provider ID or agent origin. Both operations return readiness only when their response `supervisorId` proves that the reported process/group owns the contracted listener and the HTTP probe succeeds; restart additionally stops and waits for the currently managed process group and starts a replacement with a distinct PID. A bare port listener is insufficient for either route. The shared `WorkspaceRuntime` managed-start/restart conformance suite runs against `MemoryWorkspaceRuntime`, the local HTTP workspace-agent adapter, and the env-gated Modal provider, including unrelated-port-contender failures for both operations.

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
- 2026-08-06 WS-1 interface extension approved — product-owner delegated controller decision added typed, allowlisted `merge` and `revert` Git operations required by AR-4; ADR-0010 records the deviation.
- 2026-08-06 WS-1 interface extension approved — product-owner delegated controller decision added managed dev-server restart and atomic workspace batch writes required by AR-4 review fixes; ADR-0011 records the deviation.
- 2026-08-06 WS-1 interface extension approved — ADR-0013 adds typed search, nonrecursive file deletion, atomic replace rename, and process-owned readiness; production/cloud adapters bind path operations to ADR-0006 descriptor-relative enforcement.
- 2026-08-06 WS-1 alias/idempotency guarantees clarified — Atomic batches reject canonical and observable same-inode duplicates before staging, repeated absent-file deletion succeeds, and rename rejects normalized, canonical, and same-inode self-aliases.
- 2026-08-06 WS-1/WS-3/WS-4/WS-13 binding clarified — Atomic writes reject leaf symlinks and parent-filesystem case/Unicode aliases before staging; exact descriptor-relative workspace-agent/cloud routes and shared memory/local-agent/Modal conformance suites are binding, with no AR-4 cloud placeholder.
- 2026-08-06 WS-4/WS-13 lifecycle routes clarified — Both service-token-authenticated internal start and restart routes map one-for-one through the provider/client to strict workspace-agent routes and require identical supervisor-owned readiness in local HTTP and Modal conformance.
- 2026-08-04 WS-2 BLOCKED — Step 1 requires baking the real `sandbox/workspace-agent` and `sandbox/preview-proxy` builds, but those source trees are produced by WS-3 and WS-10 and do not exist yet. No placeholder image content is permitted; complete WS-3 and WS-10, then resume WS-2. Modal dev credentials are available and are not the blocker.
- 2026-08-05 WS-3 review fixes verified / smoke pending — isolated branch `task/WS-3` at `e8f08bb` passed independent spec and quality review, workspace-agent current Node and Node 22.23.1 suites 74/74, and uncached repository test/lint/typecheck/build 17/17, 14/14, 13/13, 8/8. WS-3 remains unchecked and off `main` until WS-2's real Modal dev VM capability smoke passes.
- 2026-08-05 WS-10 BLOCKED — five independent review-fix rounds exhausted on isolated branch `task/WS-10`; final package suite is 55/55 on current Node and Node 22.23.1 with uncached repository test/lint/typecheck/build at 17/17, 13/13, 12/12, and 8/8, but two real load-bearing parser findings remain: unquoted client-script `src` recognition and `<style>` raw-text scanning. The task stays unchecked and uncommitted; WS-2 remains blocked on it.
- 2026-08-07 WS-10 done — replaced the discarded hand-written scanner with parse5's streaming rewriter, preserved proxy/WebSocket/capture/SSE/selection/screenshot behavior, and structurally owned the real-Chrome test process; package suite passed 109/109 and the forced local cold gate passed 57/57. CI is unverified because GitHub billing prevented every job from starting; no Modal, Stytch, or model-provider credentials were available.
- 2026-08-07 WS-2 BLOCKED — focused Modal infra, sandbox-service, workspace-agent, and parse5 preview-proxy suites plus touched-package lint/typecheck/build are green and Modal dev credentials are present, but `pnpm modal:publish --env dev` failed closed because source revision `6841b9cf479e457d94ecdc88a05a175ba8c77b3b` is not advertised by `https://github.com/crossbizz/zapp.git`; no immutable tag exists for the required real VM/agent/preview smoke, so WS-2 and WS-3 remain unchecked.
- 2026-08-07 WS-2 BLOCKED — after provisioning `zapp-dev` and fixing the pinned-snapshot CA bootstrap (`3d32d0d`, Modal infra 19/19 plus lint/typecheck/build), the real Modal build reaches the immutable-source clone but the private GitHub repository rejects anonymous access; no explicitly scoped build token is configured and Modal JS SDK 0.9.0 exposes no local-source upload primitive, so injecting a workstation credential would violate the structural secret boundary. No image tag exists for the required Node/agent/cgroup/proxy/volume/snapshot/tunnel/readiness smoke; WS-2 and WS-3 remain unchecked pending an approved source-delivery mechanism.
- 2026-08-07 WS-2 BLOCKED — ADR-0020 was human-approved and the provider-neutral, single-layer private-source boundary was implemented at `2cf151f`; exact merged SHA `0d2a32f92ed209feab88cdfb8a6afd5b68d7d1ec` passed the tracked local gate and was advertised on `task/WS-2-final`. Publication still fails before image build: authenticated Modal workspace `yosemitemountain62` reports zero secret names for `modal secret list --env zapp-dev`, and `pnpm modal:publish --env dev` reports required `zapp-github-source-read` absent. No secret values were accessed. The branch push used the controller-authorized `GSTACK_REDACT_PREPUSH=skip` only for the already-published localhost Docker `zapp:zapp` literal inherited from `main`; `ZAPP_SKIP_VERIFY` was not used. No current-SHA image/tag exists, so the real smoke remains unverified and all WS-2 plan/tracker boxes remain unchecked.
- 2026-08-07 WS-2 BLOCKED — authenticated Modal workspace `yosemitemountain62` still reports zero secrets in binding environment `zapp-dev`; `zapp-github-source-read` exists only in Modal environment `main`, so the required `ZAPP_GITHUB_READ_TOKEN` cannot be resolved for the dev build. No secret values were accessed or copied. Per the resume brief's ordering, no upstream merge, publication, smoke, completion bookkeeping, or push was attempted; re-provision the named Secret in `zapp-dev` to resume.
- 2026-08-07 WS-2 BLOCKED — after the Secret resolved, exact advertised SHA `456265f1893fc06f1b71be4d2edd4eb9c3844ffe` passed authenticated source checkout, the no-secret layer, and Node 22 dependency installation in Modal dev; the capped fix round corrected the macOS-only `node-pty` helper gate, but the one authorized rerun then exposed a distinct Linux native-build defect in `path-helper.c`: `open_final_beneath` redeclares `descriptor` and the `syscall` prototype is unavailable under the current C feature macros. Per the ten-minute cap no further fix/retry was attempted. No image/tag exists, real smoke remains unverified, and all WS-2 plan/tracker boxes remain unchecked.
- 2026-08-07 WS-2 BLOCKED — reviewed Linux compile fix `f3897838e2de42fb6d2142afd9311975d966af08` was clean and exactly advertised; the real Modal dev publish completed authenticated source/no-secret/install/native builds and produced the base image, then failed at its binding VM smoke because Modal JS SDK 0.9.0 rejects mandatory sandbox tags on `experimentalCreate` (`tags are not supported by experimentalCreate`). Dropping the seven plan-required tags is not an allowed downgrade. The transaction left zero dev lock entries; no explicit smoke retry, completion bookkeeping, or final gate ran, and all WS-2 plan/tracker boxes remain unchecked pending an approved provider-compatible tagged-sandbox mechanism.
- 2026-08-07 WS-2 BLOCKED — reviewed tagged-sandbox fix `993ac502456d8bc943d60c5f282c8ead9cc0917a` was clean and exactly advertised, but the real Modal dev publish failed after four minutes at named-Secret resolution with `/modal.client.ModalClient/SecretGetOrCreate NOT_FOUND: Environment 'dev' not found`. The publisher maps `dev` to `zapp-dev`, and authenticated workspace metadata confirms `zapp-dev` plus `zapp-github-source-read` exist while environment `dev` does not, so this is a load-bearing provider environment-propagation defect rather than missing provisioning. Per the explicit re-scope rule no retry/change followed. The transaction left zero dev lock entries; smoke, completion bookkeeping, and final gate remain unrun, and all WS-2 plan/tracker boxes stay unchecked.
- 2026-08-07 WS-2 BLOCKED — reviewed physical-environment fix `5746e75065a6b90f477301621678e6ea75f1c5d4` was clean and exactly advertised; the real Modal dev publish completed the Node 22 source/install/native build and saved base image `im-i0MJWSSDsVUryfeHy3LfLI`, then the binding VM containment probe failed at authenticated `GET /exec/cleanup/:cleanupId` with `containment cleanup acknowledgement failed`; Modal logs also report `workspace-agent failed to shut down`. This is a new load-bearing runtime cleanup defect, so no retry/change followed without explicit re-scope. The transaction left zero dev lock entries; standalone smoke, completion bookkeeping, and final gate remain unrun, and all WS-2 plan/tracker boxes stay unchecked.
- 2026-08-07 WS-2 BLOCKED — reviewed cleanup-acknowledgement fix `dc5635f4eb6067688230e0f0e05c2134621cd7a2` was clean and exactly advertised; the real Modal dev publish again completed the Node 22 source/install/native build and saved base image `im-Wcz24stI2RGM59luDnR92U`, then the binding disconnect containment smoke failed before acknowledgement with `disconnect-buffered cleanup probe failed with exit code 2`. The generated probe begins `set -euo pipefail` but is executed by Debian `/bin/sh -lc`, where `dash` does not support `pipefail`; this is a new real Linux smoke-script portability defect. Per explicit re-scope no retry/change followed. The transaction left zero dev lock entries; standalone smoke, completion bookkeeping, and final gate remain unrun, and all WS-2 plan/tracker boxes stay unchecked.
- 2026-08-07 WS-2 BLOCKED — reviewed shell portability/fail-fast fix `bd4ab140c36bfdcafc4ffa589d34348281d17afe` was clean and exactly advertised; the real Modal dev publish completed the Node 22 source/install/native build, saved base image `im-poJC7q7DtFew9B3rYwhInk`, and passed the portability-fixed disconnect-buffered script, then its authenticated `GET /exec/cleanup/:cleanupId` still failed with `containment cleanup acknowledgement failed`. This is a new real cleanup-route/runtime defect beyond shell portability; per explicit re-scope no retry/change followed. The transaction left zero dev lock entries; standalone smoke, completion bookkeeping, and final gate remain unrun, and all WS-2 plan/tracker boxes stay unchecked.
- 2026-08-07 WS-2 cleanup correction verified / smoke pending — Node 22 `fs.rm(directory)` rejected the empty cgroup with `ERR_FS_EISDIR`, poisoning the exact cleanup receipt and retained shutdown ownership; the direct RED/GREEN regression now uses `rmdir(2)` after `cgroup.events` reports `populated 0`. Workspace-agent 83/83, Modal infra 23/23, sandbox-service 15/15, touched-package lint/typecheck/build, and one bounded review are green. Per the re-scoped brief no Modal publish or smoke ran, so WS-2 and WS-3 remain unchecked pending the real VM gate.
- 2026-08-07 WS-2 BLOCKED — final bounded cleanup-acknowledgement investigation traced disconnect through the exact receipt, abort, cgroup empty/removal, route, and smoke-caller state machines but could not produce a deterministic RED or prove the remaining real-VM failure: `acknowledgeCleanup` collapses every receipt rejection to `ContainmentCleanupError`, the HTTP route serializes only `containment_cleanup_failed`, and the Modal caller discards the response status/body as `containment cleanup acknowledgement failed`. Existing tests prove the success/fail-closed branches but contain no evidence selecting kill, `populated 0`, or `rmdir(2)` as the second failure. Per the ten-minute cap, no speculative production change, reviewer, publish, smoke, or completion bookkeeping followed; WS-2 and WS-3 remain unchecked. A subsequent failure in this cleanup boundary is an architectural blocker requiring new observable evidence rather than another fix round.
- 2026-08-08 WS-2 cleanup observability verified / real smoke pending — a shared strict `CleanupFailureStageSchema` now preserves only `kill`, `populated_wait`, `remove`, or `shutdown` diagnostics through the exact receipt, authenticated fail-closed 503 response, and Modal publisher error without exposing raw failures. Deterministic RED/GREEN covered the three active containment operations; contracts 129/129, workspace-agent 89/89, sandbox-service 18/18, and touched lint/typecheck/build are green. One bounded review found no Critical/Important issue and recorded one Minor: the defensive `shutdown` fallback is not included in the new cross-layer test tables. No fix round, Modal publish/smoke, or WS-2/WS-3 completion bookkeeping ran; both tasks remain unchecked for the controller's exact-SHA real VM gate.
- 2026-08-08 WS-2 BLOCKED — exact clean advertised SHA `05606919b2f7e657531a56e5318d2a19747a9d88` ran one pinned-pnpm real Modal dev publication attempt and exited 1 at the strict cleanup boundary with HTTP 503, stable code `containment_cleanup_failed`, and stage `shutdown`. VM readiness, Node 22, agent health, preview-proxy health, and source-credential absence were the last unambiguously successful smoke boundaries; the closed diagnostic does not identify the cleanup sub-probe, and no image ID was emitted. The transaction left no dev lock entry or publication-lock directory; no retry, standalone smoke, production change, task bookkeeping, or full gate followed, so WS-2 and WS-3 remain unchecked pending a separately authorized investigation.
- 2026-08-08 WS-2 disconnect receipt ownership verified / real smoke pending — deterministic buffered-disconnect RED proved the outer execution error settled the cleanup receipt before its already-bound `active.done` owner, surfacing `shutdown` and masking later containment success or the exact `remove` stage. Cleanup receipts now explicitly bind to `active.done`; only unbound pre-start failures settle through the outer path. Focused 2/2, workspace-agent 91/91, contracts 129/129, sandbox-service 18/18, touched lint/typecheck/build, and one bounded clean review are green. No fix round or Modal publish/smoke ran; WS-2 and WS-3 remain unchecked for the controller's exact-SHA real VM gate.
- 2026-08-08 WS-2 BLOCKED — exact clean advertised SHA `c1560b585cda7d5ca0f548f1c584cc9471f91acb` ran one real Modal dev publication attempt under pinned pnpm 9.15.0 and exited 1 at `explicit-kill-buffered cleanup probe failed with exit code 1`. Ordered smoke execution proves readiness, Node 22, agent health, preview-proxy health, source-credential absence, buffered/PTY timeout cleanup, and buffered disconnect cleanup completed first; no image ID/digest or lock record was emitted. The transaction left no dev lock entry, publication-lock directory, or temporary lock file; no retry, standalone smoke, production change, completion bookkeeping, or full gate followed, so WS-2 and WS-3 remain unchecked pending investigation of the explicit-kill buffered lifecycle.
- 2026-08-08 WS-2 explicit-kill observability verified / real smoke pending — the explicit-kill probe now emits and parses only `started_wait`, `identity_parse`, `kill_request`, `stream_completion`, `kill_acknowledgement`, `exit_record`, or `exit_code_validation`, preserving the stable purpose and shell exit status without raw output. A Debian dash RED/GREEN forced the real kill-acknowledgement assertion through the Modal publisher; sandbox-service 21/21, directly affected Modal infra 23/23, touched lint/typecheck/build, and one SOL High review are clean. No fix round or Modal publish/smoke ran, and WS-2/WS-3 remain unchecked for the exact-SHA real VM gate.
- 2026-08-08 WS-2 BLOCKED — exact clean advertised SHA `1f86ad067965f7f504b037f802c36742e4045e67` ran one real Modal dev publication attempt under pinned pnpm 9.15.0 and exited 1 at stable purpose `explicit-kill-buffered cleanup probe failed with exit code 1`, strict phase `started_wait`. Buffered disconnect cleanup was the last successful ordered boundary; no current-SHA image ID/digest/tag or dev lock record was emitted, and the transaction left no publication-lock directory or temporary lock file. Per the capture brief there was no retry, standalone smoke, production edit, completion bookkeeping, or full gate, so WS-2 and WS-3 remain unchecked pending a separately authorized explicit-kill lifecycle investigation.
- 2026-08-08 WS-2 explicit-kill start boundary verified / real smoke pending — the dash probe now observes `started` through the existing 30-second execution deadline, closes early request completion as `request_completed_before_started`, and preserves `started_wait` when the deadline closes. Poll-201, early-completion, deadline-race, and later kill-acknowledgement regressions passed; sandbox-service 24/24, Modal infra 23/23, and touched lint/typecheck/build are green. One SOL High review found one Important deadline-overhead race, fixed in the single allowed round with a concurrent deadline process. No Modal run or WS-2/WS-3 completion bookkeeping ran; both remain unchecked for the exact-SHA real VM gate.
- 2026-08-08 WS-2 BLOCKED — exact clean advertised SHA `e70b568cba3c48097d0415fd308c2566699f6ddc` ran one real Modal dev publication under Node 22.23.1 and pinned pnpm 9.15.0, then exited 1 at stable purpose `explicit-kill-buffered cleanup probe failed with exit code 1`, strict phase `started_wait`. Buffered disconnect cleanup was the last successful ordered lifecycle boundary. No current-SHA image ID/digest/tag or dev lock entry was emitted, and no publication-lock directory or temporary lock file remained. There was no retry, standalone smoke, code change, completion bookkeeping, or full gate, so WS-2 and WS-3 remain unchecked pending separately authorized investigation.
- 2026-08-08 WS-2 live curl buffering verified / real smoke pending — a real curl/HTTP RED reproduced `started_wait` while a small initial NDJSON record remained buffered in redirected output; the five generated background consumers that inspect output before completion now use curl `--no-buffer` (explicit-kill buffered/PTY, shutdown buffered/PTY, PID-ownership request B). Focused 2/2, sandbox-service 26/26, Modal infra 23/23, touched lint/typecheck/build 7/7, and dash/diff checks are green. One SOL High review found no Critical/Important issue and recorded one Minor fixed-port collision risk in the real-curl test; no fix round or Modal run followed, and WS-2/WS-3 remain unchecked for the exact-SHA real VM gate.
- 2026-08-08 WS-2 real Modal curl-stream verification passed / completion bookkeeping deferred — exact clean advertised SHA `c58a416cba65f57ea64ba3e3e90f3646efca9b62` ran one Node 22.23.1 / pinned pnpm 9.15.0 dev publication and, after its exit 0, one standalone dev smoke; both exited 0 with all strict VM, lifecycle, credential-absence, volume, snapshot, tunnel, and readiness evidence closed. The atomic lock now records tag `2026-08-08-c58a416`, base digest `im-9NCxx8merCgh67jj0YLM84`, and web-test digest `im-eVxjg43Gv7bQrkH0CbwrrX`; no publication-lock directory or temporary lock file remains. There was no retry, interruption, timing/assertion change, code edit, bypass, or raw credential/output capture in committed evidence. Per the controller brief, WS-2/WS-3 plan and tracker boxes remain unchecked pending the evidence commit/push handoff.
- 2026-08-08 WS-2 BLOCKED — one clean-HEAD tracked local gate under Node 22.23.1 and pinned pnpm 9.15.0 exited 1 in its concurrent unit phase: sandbox-service's explicit-kill old-boundary test timed out (1 failed, 25 passed), Modal infra's injected-clock writer-lock test lost its 100 ms wall-clock race (1 failed, 22 passed), and workspace-agent's 256-entry replay-pressure test timed out (1 failed, 90 passed). Turbo finished 67/70 tasks in 3m20.311s; the subsequent integration, isolation, and Gate-5 phases did not run. The failures are load-sensitive verification-boundary defects rather than demonstrated runtime regressions, but the failed required gate remains failed; no retry, production fix, or completion bookkeeping followed, and WS-2/WS-3 stay unchecked for a fresh fix task.
- 2026-08-08 WS-2 done — real Modal dev publish and standalone smoke at source `c58a416cba65f57ea64ba3e3e90f3646efca9b62` exited 0 with immutable tag `2026-08-08-c58a416`, base digest `im-9NCxx8merCgh67jj0YLM84`, web-test digest `im-eVxjg43Gv7bQrkH0CbwrrX`, and all strict VM/lifecycle/credential-absence/volume/snapshot/tunnel/readiness evidence; after the three bounded test-stability repairs and one clean SOL High review, exact advertised SHA `90305ed8fef549998555e8b027dcb9e3f24d0f8a` passed the one-shot locked local gate under Node 22.23.1/pnpm 9.15.0: concurrent 70/70, integration 15/15 (DB 48/48, Git 16/16, control API 236/236), isolation 54/54, and Gate 5 1/1. WS-3 remains unchecked.
- 2026-08-08 WS-3 BLOCKED — the reviewed workspace-agent implementation and current published image passed focused daemon/auth checks 7/7, the dependency-built full suite 91/91, WS-1 conformance 35/35, package lint/typecheck/build 5/5, and one real Modal standalone smoke against tag `2026-08-08-c58a416` with strict authenticated VM/lifecycle/containment and capability evidence. WS-3 remains unchecked only because its binding guarded-write acceptance requires WS-4's production cloud runtime to prove successful revision-CAS commit plus deterministic final-window conflict with zero target writes across every writer domain; that provider/conformance path does not exist yet.
