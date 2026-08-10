# Plan 05 — Verification & Quality System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capability detection, the gate engine with support-level policies, Playwright generation + browser agent, the independent Verifier, bounded repair loops, anti-slop guardrails, and evidence manifests — PRD §17, §24, and the verification halves of §15.2/§34.

**Architecture:** `packages/project-adapters` detects frameworks and derives execution contracts. `packages/verification-engine` defines gates + criteria traceability + evidence. `services/verification-service` (4400) hosts browser-agent sessions on `forge-web-test` sandboxes. The Verifier is an orchestrator role with **its own workspace, its own gate runs, and authority to reject** — it never reuses builder-reported results (PRD §7.3).

**Tech Stack:** Playwright, axe-core, gitleaks (binary in image), osv-scanner, knip (unused deps), ts-morph (AST checks), @zapp/{contracts,workspace-runtime,agent-tools}.

**Milestone:** VF-1..5 (M2), VF-6..16 (M3). **Depends on:** Plans 01–04. **Consumed by:** 07 (release gates), 04 (repair loop), 08 (evidence UI).

## Global Constraints

Master plan §Global Constraints, plus:
- Verifier runs gates in a **fresh workspace from the task's output commit** — never the builder's live workspace.
- The browser agent uses DOM, accessibility tree, network, and console evidence — screenshot interpretation alone is never sufficient (PRD §24.4).
- A gate result is `{ status: "passed"|"failed"|"waived"|"not_applicable", evidenceArtifactIds[], details }`; waivers require recorded actor + reason and surface in evidence manifests.
- Generated tests use `data-testid` selectors (generation adds them via code edit when missing); text selectors only as fallback with a flake annotation.

## File structure owned

```text
packages/project-adapters/src/{types,detect,generic-node,vite,react,next,nuxt,sveltekit,astro,express-fastify,nest,capacitor}.ts
packages/verification-engine/src/{gates/registry,gates/*,criteria,evidence,policy-matrix,anti-slop/*}.ts
services/verification-service/src/{app,browser-agent/{session,driver},routes}.ts
```

---

### Task VF-1: Adapter framework + generic Node adapter

**Files:** Create: `packages/project-adapters/src/{types,detect,generic-node}.ts`, `test/generic-node.test.ts`, `test/fixtures/` (minimal projects)
**Interfaces produced:** `ProjectAdapter` (FND-4) implementations; `detectProject(runtime): Promise<{ adapterId, confidence, evidence }[]>` ranked; generic-node fallback always matches (PRD §17.3): package manager from lockfile (pnpm-lock/yarn.lock/package-lock/bun.lockb), commands from package.json scripts (`dev|start`, `build`, `test`, `typecheck|tsc`, `lint`), port from script args/env/`PORT`, workspace root detection for monorepos (pnpm-workspace.yaml/turbo.json → root + target package selection recorded as open question when ambiguous).
**Effort:** L

- [x] **Step 1:** Failing tests against 6 fixture projects (npm CRA-like, pnpm vite, yarn express, pnpm monorepo, no-scripts bare, bun) asserting detected manager/commands/port; ambiguity object for monorepo without obvious app target.
- [x] **Step 2:** Implement detection via `listFiles` + `readFile` on the runtime interface (works local + cloud).
- [x] **Step 3:** Commit: `feat(project-adapters): detection framework + generic node fallback`

### Task VF-2: Framework adapters (P0 set)

**Files:** Create: adapters + fixtures for Vite, React, Next.js, Nuxt, SvelteKit, Astro, Express/Fastify, NestJS, Capacitor-detect
**Effort:** L

- [x] Binding behavior: each adapter refines: detection (config files: `next.config.*`, `vite.config.*`, `nuxt.config.*`, `svelte.config.*`, `astro.config.*`, `nest-cli.json`, capacitor.config.*), dev port defaults (next 3000, vite 5173, astro 4321, nuxt 3000…), health path, route discovery (`discoverRoutes`: next app/pages dir scan, vite-react react-router static scan best-effort, sveltekit routes dir, astro pages), build output expectations, proposeDeployment hints (next/vite/astro/sveltekit → vercel-compatible; express/fastify/nest → container); Capacitor: detect + preserve (never break native folders), no store-release support flag (PRD §17.3).
- [x] Failing tests: one fixture per adapter asserting contract fields + ≥ 3 discovered routes for the next/sveltekit fixtures.
- [x] Commit: `feat(project-adapters): P0 framework adapter set`

### Task VF-3: Capability scan pipeline

**Files:** Create: `packages/project-adapters/src/scan.ts`; Modify: CP-6 scan route wiring; Create: `test/integration/scan.test.ts`
**Effort:** M

- [x] Binding behavior (PRD §17.1): `POST /v1/projects/:id/scan` → Temporal activity in workspace: run detection → derive `ExecutionContract` → detect DB provider (env/DATABASE_URL/supabase config/drizzle|prisma configs), auth provider, deployment config (vercel.json/fly.toml/Dockerfile), existing unit/integration/browser tests (ADR-0014), observability (sentry/faro/otel/posthog imports — detection covers tools users already have, independent of zapp's own stack) → store `project_contracts` row (version++) → compute support level: `compatible` always; `verified`-eligible flag when build+typecheck+test contracts known; report card artifact with missing-capability list ("Harden this project" input, PRD §10.2 step 8).
- [x] Failing integration test: scan a fixture next+supabase project → contract row with framework=next, database=supabase, eligibility flags correct.
- [x] Commit: `feat: capability scan pipeline producing execution contracts + support level`

### Task VF-4: Gate engine core + policy matrix

**Files:** Create: `packages/verification-engine/src/{gates/registry,policy-matrix}.ts`, `test/policy-matrix.test.ts`
**Interfaces produced (binding):**

```ts
export interface Gate {
  id: GateId;                       // "dev_server_start" | "production_build" | "typecheck" | "lint" |
                                    // "unit_tests" | "integration_tests" | "browser_smoke" | "browser_acceptance" |
                                    // "authorization_tests" | "migration_validation" | "secret_scan" |
                                    // "dependency_scan" | "preview_health" | "rollback_readiness" | "observability_check"
  run(ctx: GateContext): Promise<GateResult>;   // GateContext: fresh runtime, contract, commit, criteria, artifacts sink
}
export function requiredGates(level: SupportLevel, projectPolicy: ProjectPolicy): GateRequirement[];
// encodes PRD §24.2 matrix EXACTLY (Required / Best effort / If available / Project policy / Optional / No / Advisory)
```

**Effort:** M

- [x] Failing test: the full §24.2 matrix table-driven (15 gates × 3 levels) asserting requirement classes; waiver handling (`typecheck` waived on Verified requires explicit waiver object).
- [x] Commit: `feat(verification-engine): gate registry + support-level policy matrix`

### Task VF-5: Deterministic gates (build/type/lint/unit/secret/dev-server)

**Files:** Create: `src/gates/{dev-server,build,typecheck,lint,unit-tests,secret-scan,shared}.ts`, `test/gates.test.ts`, `docs/adr/0026-verification-image-toolchain.md`; Modify: `src/gates/registry.ts`, `src/index.ts`, `infra/modal/{image-config.json,images/config.ts,images/forge-node-base.ts,images.lock.json,test/images.test.ts,test/publish.test.ts}`, `services/sandbox-service/src/provider/{modal,types}.ts`, `services/sandbox-service/test/modal.test.ts`
**Effort:** L

- [x] Binding behavior: each runs the contract command in the gate workspace with timeout from contract; structured result parsing (exit code + parsed summaries: vitest/jest JSON reporters when detectable, tsc error count, eslint JSON); secret_scan = Gitleaks against the diff range (base..head) + full scan weekly flag; dev_server_start = supervisor probe via WS-13; every gate stores raw log artifact + parsed summary through the branded registered-secret redaction boundary from ADR-0026.
- [x] Failing tests against fixture repos incl. one with a runtime-assembled planted `sk_live_` shape (secret gate fails with file+line, value absent from report); recipe RED requires the exact checksum-pinned Gitleaks binary.
- [x] Publication prerequisite: after the two-round local review exits clean, create and advertise one source checkpoint for Modal's immutable Git fetch; the prescribed completion commit then records the atomic image lock, tracker, and execution log after the one real acceptance.
- [x] Final acceptance only: publish one immutable dev image, and require its existing publisher smoke to execute the real Gitleaks binary against the planted Git diff before atomically updating `images.lock.json`. Review rounds run local suites only.
- [x] Commit: `feat(verification-engine): deterministic gate set`

### Task VF-6 [M3]: Preview health + browser smoke gates

**Files:** Create: `src/gates/{preview-health,browser-smoke}.ts`
**Effort:** M

- [x] Binding behavior: preview_health = HTTP 200 on contract health path via preview proxy + zero uncaught console errors during load; browser_smoke = Playwright: visit each discovered route (cap 10, prioritized: /, auth, first nav links), assert no error boundary/blank root, capture screenshot + console + failed requests per route as evidence artifacts.
- [x] Commit: `feat(verification-engine): preview health + browser smoke gates`

### Task VF-7 [M3]: Playwright runner + artifact pipeline

**Files:** Create: `services/verification-service/src/{app,routes}.ts`, `src/runner/playwright.ts`
**Effort:** L

- [ ] Binding behavior: verification-service runs suites in `forge-web-test` workspaces: installs nothing at runtime (image-pinned browsers), executes `playwright test --reporter=json` + trace/screenshot/video-on-failure, uploads artifacts to R2 via artifact records (`test_runs` + `test_cases` rows per PRD §23.4, evidence artifact ids linked), exposes `/internal/verification/browser-run` for orchestrator activities; flake policy: single auto-retry for `timeout|navigation` failure classes, retried-pass recorded as `flaky: true` (quarantine-with-visibility, master risk table).
- [ ] Failing integration test: run a 2-test fixture suite (1 pass, 1 fail) → rows + artifacts + JSON summary with failure screenshot present.
- [ ] Commit: `feat(verification-service): playwright execution with evidence artifacts`

### Task VF-8 [M3]: Playwright generation

**Files:** Create: `packages/verification-engine/src/generate/{smoke,acceptance}.ts`, `test/generate.test.ts`
**Effort:** L

- [x] Binding behavior: smoke specs generated from discovered routes (template: goto → `expect(page).toHaveTitle(/.+/)` + root visible + zero console errors); acceptance specs generated from AC via builder-role session with a constrained prompt (input: AC text + route map + component inventory; output: spec file using `data-testid`; generation adds missing testids via code edit task); generated files land under `e2e/zapp/*.spec.ts` in the project repo (committed — user owns their tests, PRD §3.2 data portability); determinism rules: no `waitForTimeout`, network-idle waits banned by lint on generated code (custom check).
- [x] Failing tests: template generation snapshot for fixture route map; lint rejects a `waitForTimeout` fixture.
- [x] Commit: `feat(verification-engine): smoke + acceptance test generation`

### Task VF-9 [M3]: Acceptance-criteria traceability

**Files:** Create: `src/criteria.ts`, `test/criteria.test.ts`
**Effort:** M

- [ ] Binding behavior (PRD §24.3): `CriterionRecord = { criterionId, specificationVersion, taskIds[], testCaseIds[], result: "passed"|"failed"|"unverified"|"waived", evidenceArtifactIds[], verifierComments }`; assembly joins plan (AC↔task) + test runs (test↔AC via annotation `// @zapp-criterion AC-3` in generated specs, parsed from test titles `[AC-3]`); **completion-report rule: any final message/evidence omitting failed or unverified criteria is a policy violation** — enforced by the report builder (it always enumerates all criteria; no filtering path exists).
- [ ] Failing tests: mapping from fixture plan+results; unverified criterion always present in report output.
- [ ] Commit: `feat(verification-engine): criteria traceability records`

### Task VF-10 [M3]: Verifier decision engine

**Files:** Create: `src/verifier/decision.ts`, orchestrator activity `verifyPhase`, `test/integration/verifier.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §7.3, §15.2): activity `verifyPhase(runId, phaseId, commitSha)`: fresh workspace at commit → required gates for support level → browser acceptance for critical-flow AC → criteria assembly → decision `approved | rejected | needs_human` with `criteria_results_json`, `risks_json` → `verification_results` row + `verification.completed` event; **rejection authority test:** builder session reporting "done" with a failing gate → verifier rejects, task → `repairing` (never `passed`); verifier never reads builder's claimed results (input is commit sha only — enforced by activity signature).
- [ ] Commit: `feat(verifier): independent phase verification with rejection authority`

### Task VF-11 [M3]: Browser agent (exploratory verification)

**Files:** Create: `services/verification-service/src/browser-agent/{session,driver}.ts`
**Effort:** XL → split at execution (driver primitives / agent loop / evidence emission). **[expand-at-execution]**

**Scope (ADR-0017):** deterministic Playwright (VF-7/VF-8) is the M3 gate; this exploratory agent is **best-effort** — findings are evidence-schema-gated (already required below) and never a merge blocker, and agent non-determinism is not a P1 review finding. Binding behavior (PRD §24.4): agent session (verifier role, model via gateway) drives Playwright through typed primitives: `snapshotAccessibilityTree`, `listInteractive`, `click(ref)`, `fill(ref, value)`, `expectVisibleText`, `readConsole`, `readFailedRequests`, `screenshot(label)`; explores critical flows from spec journeys; produces structured findings `{ flow, steps[], status, evidence }`; hard rules: assertions must cite DOM/a11y/network/console evidence (finding without evidence ref is dropped by schema); no raw screenshot-only judgments; session budget 15 min/flow.

### Task VF-12 [M3]: Accessibility gate

**Files:** Create: `src/gates/accessibility.ts`
**Effort:** S

- [ ] Binding behavior: axe-core scan on critical routes (spec-flagged), threshold: zero `critical` violations for Verified+ (serious+ reported as warnings) — evidence: per-route violation JSON artifact.
- [ ] Commit: `feat(verification-engine): accessibility scan gate`

### Task VF-13 [M3]: Repair loop

**Files:** Create: `src/repair/{classify,loop}.ts`, orchestrator wiring, `test/integration/repair.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §24.5): classification of failure → `product_code | test_code | environment | flaky_dependency | infrastructure` (heuristics: infra = sandbox/timeout/OOM signatures; flaky = retried-pass or known flake list; else diff-informed model classification with code-side final say); budgets exactly: transient infra 3 retries, deterministic code/test 2 repair iterations, security/destructive-migration failures **no automatic override**; repair task creation feeds builder only relevant evidence (failing gate output, related files, criterion) via AR-7 context; each iteration = new commit + targeted re-check + affected gate set; exhaustion → `task.failed` + escalation event with blocker summary + full evidence links.
- [ ] Failing integration test: seeded failing unit test → 1st repair fixes (loop exits); unfixable fixture (contradictory test) → stops at 2 iterations with escalation; infra-classified failure retries without consuming repair budget.
- [ ] Commit: `feat(verification): classified repair loop with hard budgets`

### Task VF-14 [M3]: Anti-slop guardrails

**Files:** Create: `src/anti-slop/{placeholder,todo,duplicate,unused-deps,empty-catch,disabled-tests,diff-size,mock-detect,states-check}.ts`, `test/anti-slop.test.ts`
**Effort:** L

- [ ] Binding behavior (PRD §24.6, policy signals with severity by context, not universal blockers): placeholder text scan (lorem ipsum, "TODO: implement", `<p>Placeholder`) in release-critical routes; introduced TODO/FIXME in diff for required features → warning, blocking for Managed; duplicate-component heuristic (new file > 80% token-similar to existing component → suggest modification instead); unused deps via knip; empty catch via AST (ts-morph); disabled tests (`.skip`, `xit`) introduced without waiver; broad-rewrite detector (task diff > config threshold lines vs task estimate → flag); mock-left-active detector (Prototype mock registry entries still referenced in Managed release build); missing loading/empty/error states heuristic for critical-flow routes (component renders fetch without error boundary/loading branch → warning). Each check returns policy signal `{ id, severity(level, context), locations, autofixable }` consumed by verifier decision.
- [ ] Failing tests: one fixture per detector (9 fixtures) asserting signal + severity at each support level.
- [ ] Commit: `feat(verification-engine): anti-slop policy detectors`
- [ ] **Re-scoped by ADR-0017.** Collapse to OSS: unused deps=`knip`; empty catch=ESLint `no-empty` (already enabled); unhandled TS errors=`tsc` (already a gate); duplication=`jscpd` structural clones (NOT an 80%-token-similarity heuristic); TODO/FIXME/placeholder=Semgrep patterns. Keep only thin zapp-specific glue. Demote the two semantic-judgment checks — component similarity and "missing loading/empty/error states" — to Minor signals or defer to OPS-13; do not build a semantic-similarity engine.

### Task VF-15 [M3]: Evidence manifest assembly

**Files:** Create: `src/evidence.ts`, `test/evidence.test.ts`
**Effort:** M

- [ ] Binding behavior: `assembleEvidenceManifest(releaseCandidate)` → JSON exactly PRD §27.4 shape (release_id, commit_sha, specification_version, criteria[] from VF-9, build/typecheck/tests/browser_tests/security/migration/preview/rollback blocks from gate results, known_risks[]) + human-readable report exactly Appendix D format; stored as immutable artifact linked from `releases.evidence_manifest_artifact_id`; report always enumerates every required gate + every criterion (VF-9 rule).
- [ ] Failing tests: manifest from seeded gate results matches schema; Appendix D text renderer snapshot.
- [ ] Commit: `feat(verification-engine): release evidence manifest + report renderer`

### Task VF-16 [M3]: Dependency scan + migration validation gates

**Files:** Create: `src/gates/{dependency-scan,migration-validation}.ts`
**Effort:** M

- [ ] Binding behavior: dependency_scan = osv-scanner on lockfile; policy: critical vulns block Verified+ unless waived, advisory for Compatible (PRD §24.2); migration_validation = plan-06 DB adapters validate pending migrations against an isolated branch/database (Neon branch or Supabase shadow), classify destructive ops (VF uses AR-5 destructive-SQL detector), record reversibility state `reversible | compensating | unavailable` for release evidence (PRD §25.4).
- [ ] Commit: `feat(verification-engine): dependency + migration gates`

---

## Testing strategy
- Fixture-driven: `test/fixtures/` grows into the PRD §40.2 benchmark seed set (React/Vite CRUD, Next SaaS, monorepo, planted-regression app…). Fixtures double as VF unit fodder and M6 validation apps.
- Verifier-rejects-builder (VF-10) and repair-budget (VF-13) integration tests are permanent CI — they encode the product's core promise.

## Scalability notes
- Gate runs parallelize per gate class in one workspace where side-effect-free (lint/typecheck concurrent; build exclusive); browser suites fan out to separate web-test sandboxes capped by plan concurrency.

## Security & tenancy notes
- Verifier workspaces use `restricted_verification` network profile (WS-11) for deterministic gates; secret scan runs before any artifact upload; evidence artifacts inherit tenant-scoped R2 prefixes.

## Execution log

- 2026-08-06 VF-3 interface input approved — ADR-0014 adds optional `ExecutionContract.test.integration`; capability scanning owns detection and population of that command.
- 2026-08-09 VF-1 done — added ranked runtime-only detection and a generic Node execution-contract fallback across npm, pnpm, yarn, bun, and ambiguous monorepos.
- 2026-08-09 VF-4 done — encoded all 45 PRD gate-policy cells, explicit actor-attributed waivers, and the public workspace-runtime gate registry; repaired the clean-CI export test to require no stale `dist/`.
- 2026-08-09 VF-5 done — shipped six deterministic gates behind a branded artifact-redaction boundary, baked checksum-pinned Gitleaks 8.26.0, and passed the one real Modal publisher smoke with a redacted planted diff at immutable tag `2026-08-09-6b22eea` after two review rounds.
- 2026-08-09 VF-2 done — added ranked P0 framework adapters, exact filesystem route discovery, deployment/output metadata, and Capacitor native-preservation semantics; explicit detect/export joins extended the terse create-only file list.
- 2026-08-10 VF-3 done — production-composed tenant-scoped capability scans through Temporal, sandbox-service, and R2 with stable retry identity; real DB/Temporal integration and one immutable-image Modal smoke passed.
- 2026-08-10 VF-8 done — Added keyed committed smoke/acceptance generation with exact criterion traceability, stable-selector enforcement, validated edit receipts, and clean-index isolation; after the two-round review cap, the cold gate exposed inherited 5s envelopes preempting real-Git diagnostics under contention, so those fixtures adopted the existing bounded 60s precedent; 27/27 package tests passed with no interface deviations.
- 2026-08-10 VF-6 done — Added strict preview-health and capped adapter-route Playwright smoke gates with per-route screenshot, console, and request evidence; the single capped review found and fixed visited-route cap loss and failure-path screenshot omission; package gates and root lint/typecheck passed with no provider run required.
