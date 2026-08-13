# WEB-18 Real API Product Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reference-quality authenticated web shell, prompt dashboard, project gallery, conversational builder, and in-builder Manage surface using only the public `/v1` API, generated SDK, and structured agent events.

**Architecture:** Existing API-backed screens remain the product source. A shared React shell composes navigation around them, focused TypeScript modules own navigation and view projection, and extracted settings modules render both at their canonical routes and inside the builder. One new tenant-scoped read contract exposes the latest redacted preview screenshot as an optional project thumbnail.

**Tech Stack:** TypeScript 5.6 strict mode, React 19, Next.js 15 App Router, Zod 3.25, Fastify 5, Drizzle/PostgreSQL, generated `@zapp/api-client`, `@zapp/ui`, CSS Modules, Vitest, Playwright, axe.

## Global Constraints

- Master plan Global Constraints 1 through 20 apply unchanged.
- API first: clients consume public `/v1` operations only through `createControlPlaneClient`; no browser-private route, handwritten response type, or direct service call.
- Stytch B2B remains the identity provider. The browser uses the existing control-plane redirect and cookie session; no Stytch secret or SDK is added to the client.
- Run state comes only from structured `AgentEvent` payloads and public read models. No assistant-prose parsing.
- Unsupported provider cards are absent. P0 integration cards are GitHub, Supabase, Neon, Stripe, and Vercel.
- Account Billing and the generated application's Stripe integration are separate surfaces with distinct copy.
- Cross-tenant reads return 404. The thumbnail route verifies organization, project, artifact type, storage hash, and byte bound.
- Credential and secret values are write-only. They never enter URLs, logs, events, fixtures, analytics, rendered error detail, or read responses.
- Every mutating request uses its existing idempotency contract. A visible retry of the same user intent reuses the same key.
- TypeScript owns navigation models, provider metadata, schemas, reducers, request fences, and formatters. TSX is reserved for JSX-rendering components.
- Styling uses existing semantic CSS tokens and CSS Modules. Do not add a CSS-in-TypeScript runtime or raw hex values in components.
- Preserve direct settings, releases, health, usage, billing, and audit routes while reusing the same components inside the shell.
- Full keyboard navigation, focus restoration, polite live regions, icon-plus-text statuses, and axe-clean core flows are required.
- Review is capped at two local rounds. Real-provider verification runs once at the final task gate; local review rounds do not consume providers.

---

### Task 1: Tenant-scoped project preview thumbnails

**Files:**
- Modify: `services/control-api/src/tenant/view.ts`
- Modify: `services/control-api/src/tenant/db.ts`
- Modify: `services/control-api/src/routes/project-summaries.ts`
- Modify: `services/control-api/src/app.ts`
- Modify: `services/control-api/test/support/tenant-db.ts`
- Modify: `services/control-api/test/support/harness.ts`
- Modify: `services/control-api/test/project-summaries.test.ts`
- Modify: `services/control-api/test/integration/projects.test.ts`
- Modify generated: `packages/api-client/openapi.json`
- Modify generated: `packages/api-client/src/generated.ts`
- Modify generated: `packages/api-client/src/generated-operations.ts`
- Modify: `packages/api-client/test/client.test.ts`
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Produces: `ProjectPreviewThumbnailSchema` with `{ artifactId, contentHash, capturedAt, alt }`.
- Extends: `ProjectDashboardSummarySchema.previewThumbnail`, nullable.
- Produces: `TenantProjectSummaryRepository.getPreviewThumbnail(projectId, artifactId)` returning a tenant-bound screenshot artifact or `undefined`.
- Produces: generated `GET /v1/projects/{projectId}/preview-thumbnail/{artifactId}` returning `{ thumbnail: { contentType, encoding: 'base64', content, contentHash } }`.
- Consumes: the existing `RunArtifactReaderPort.read({ key, maxBytes })` and screenshot artifacts already stored by the verification/preview pipeline.

- [ ] **Step 1: Add failing summary and thumbnail route tests**

Extend `project-summaries.test.ts` with a latest screenshot artifact and an injected artifact reader. Assert:

```ts
expect(summary.previewThumbnail).toEqual({
  artifactId: screenshot.id,
  contentHash: 'b'.repeat(64),
  capturedAt: '2026-08-13T18:04:00.000Z',
  alt: 'Preview of Alpha project',
});

expect(await thumbnailResponse.json()).toEqual({
  thumbnail: {
    contentType: 'image/png',
    encoding: 'base64',
    content: pngBytes.toString('base64'),
    contentHash: 'b'.repeat(64),
  },
});
```

Cover no screenshot as `previewThumbnail: null`, foreign project 404, screenshot from another project 404, non-screenshot artifact 404, storage miss 404, content hash mismatch 409, and body larger than the existing public artifact byte cap.

Run:

```bash
pnpm --filter @zapp/control-api test -- project-summaries.test.ts
```

Expected RED: `previewThumbnail` is stripped by the strict schema and the thumbnail route returns 404.

- [ ] **Step 2: Extend the strict projection and tenant repository**

Add schemas inferred from Zod:

```ts
export const ProjectPreviewThumbnailSchema = z.object({
  artifactId: idSchema('art'),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  capturedAt: z.string().datetime(),
  alt: z.string().min(1).max(160),
}).strict();
```

Add one lateral query to `projectSummaries.forProjects` for the latest `artifacts.type = 'screenshot'` row scoped by organization and project. Return its id, hash, and creation time. Build `alt` from the tenant-owned project name. Do not start a workspace or capture a screenshot while serving a dashboard read.

Add `getPreviewThumbnail(projectId, artifactId)` to the tenant repository. Its SQL predicate must include organization, project, artifact id, and `type = 'screenshot'`.

- [ ] **Step 3: Implement authenticated bytes and hash verification**

Register the route before `/v1/projects/:projectId`. Authorize `view_project`, read through `RunArtifactReaderPort`, accept only `image/png`, `image/jpeg`, or `image/webp`, enforce the public byte cap, recompute SHA-256, and return base64 JSON parsed by a strict Zod response schema. Use the existing `project_not_found` 404 envelope for foreign/missing combinations.

- [ ] **Step 4: Prove PostgreSQL isolation and ordering**

Extend `test/integration/projects.test.ts` to insert two screenshot artifacts for one project and a newer foreign-tenant artifact. Assert the newest same-tenant screenshot wins, input project order remains stable, and the foreign artifact cannot be read through either summaries or bytes.

- [ ] **Step 5: Generate SDK and add the web wrapper**

Run:

```bash
pnpm --filter @zapp/api-client generate
```

Add to `createControlPlaneClient`:

```ts
getProjectPreviewThumbnail: (projectId: string, artifactId: string, signal?: AbortSignal) =>
  client.request('/v1/projects/{projectId}/preview-thumbnail/{artifactId}', {
    method: 'GET',
    path: { projectId, artifactId },
    headers: headers(),
    ...(signal === undefined ? {} : { signal }),
  }),
```

Verify:

```bash
pnpm --filter @zapp/control-api test -- project-summaries.test.ts
pnpm --filter @zapp/control-api test:integration -- projects.test.ts
pnpm --filter @zapp/api-client test
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
pnpm --filter @zapp/api-client lint
pnpm --filter @zapp/api-client typecheck
```

Expected: all commands exit 0 and generated artifacts contain both new response fields and the new GET operation.

- [ ] **Step 6: Commit the API slice**

```bash
git add services/control-api packages/api-client apps/web/src/lib/api.ts
git commit -m "feat(control-api): add project preview thumbnails"
```

### Task 2: Shared application shell and branded login

**Files:**
- Create: `apps/web/src/components/shell/shell-navigation.ts`
- Create: `apps/web/src/components/shell/AppShell.tsx`
- Create: `apps/web/src/components/shell/Sidebar.tsx`
- Create: `apps/web/src/components/shell/AccountMenu.tsx`
- Create: `apps/web/src/components/shell/shell.module.css`
- Create: `apps/web/src/hooks/useAppSession.ts`
- Create: `apps/web/src/lib/app-session.ts`
- Create: `apps/web/src/components/auth/auth.module.css`
- Create: `apps/web/test/product-shell.test.ts`
- Modify: `apps/web/src/app/login/page.tsx`
- Modify: `apps/web/src/components/session-home.tsx`
- Modify: `apps/web/package.json`
- Modify: `packages/config/test/turbo.test.ts`
- Modify: `packages/ui/src/tokens.css`
- Modify: `apps/web/e2e/web-1.spec.ts`
- Modify: `apps/web/e2e/accessibility.spec.ts`

**Interfaces:**
- Produces: `ShellDestination`, `shellDestinations(role)`, and `recentProjectDestination(project)` from `.ts`.
- Produces: `useAppSession()` returning `{ state, profile, membership, organizationId, switchOrganization, retry, signOut }`.
- Produces: `AppShellProps` with `{ session, activePath, recentProjects, compactible, children }`.
- Consumes: `GET /v1/me`, organization storage helpers, and public logout.

- [ ] **Step 1: Write navigation and session RED tests**

Add `test/product-shell.test.ts` for invited-membership exclusion, URL override precedence, per-user persisted organization, owner Billing visibility, and viewer-safe destinations. Add that exact file to the web package's enumerated `tsx --test` command and update the repository manifest assertion without widening it to a glob. Extend `web-1.spec.ts` to expect branded login, organization switcher, Dashboard/Projects/Templates/Usage navigation, and sign out through the public route.

Run:

```bash
pnpm --filter @zapp/web exec playwright test e2e/web-1.spec.ts e2e/accessibility.spec.ts
pnpm --filter @zapp/web exec tsx --test test/product-shell.test.ts
```

Expected RED: login has no branded card and authenticated home has no application navigation.

- [ ] **Step 2: Implement typed navigation and session state**

Define:

```ts
export interface ShellDestination {
  readonly href: string;
  readonly icon: 'dashboard' | 'projects' | 'templates' | 'usage' | 'billing';
  readonly label: string;
  readonly ownerOnly?: boolean;
}
```

Keep organization resolution in `app-session.ts`; keep effects and state transitions in `useAppSession.ts`. Abort stale loads, redirect only an actual 401 to `/login`, and expose a real Retry for other failures.

- [ ] **Step 3: Implement the responsive shell**

Build `AppShell` and `Sidebar` with a 248-pixel desktop column, 64-pixel rail between 1024 and 1279 pixels, and Radix-backed drawer below 1024 pixels. Render organization switcher, account menu, and recent projects. Preserve keyboard order and focus return.

Add only semantic tokens to `packages/ui/src/tokens.css`: sidebar width, rail width, shell background, muted navigation state, elevated panel shadow, and gradient accent. No component raw hex.

- [ ] **Step 4: Restyle the login flow without changing transport**

Keep the current `/v1/auth/login` navigation and `userCode` forwarding. Render the zapp mark, concise sign-in copy, one primary action, and a backend-unavailable state when `NEXT_PUBLIC_CONTROL_API_URL` is absent. Do not add client-side identity storage.

- [ ] **Step 5: Wrap the authenticated home and verify**

Replace `SessionHome`'s duplicate load state with `useAppSession`; pass session data to `Hero` inside `AppShell`. Verify sign-in, sign-out, organization switch, 401 redirect, retry, keyboard navigation, and axe.

```bash
pnpm --filter @zapp/web exec playwright test e2e/web-1.spec.ts e2e/accessibility.spec.ts
pnpm --filter @zapp/ui test:unit
pnpm --filter @zapp/ui lint
pnpm --filter @zapp/ui typecheck
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

- [ ] **Step 6: Commit the shell slice**

```bash
git add apps/web/src/components/shell apps/web/src/components/auth apps/web/src/hooks/useAppSession.ts \
  apps/web/src/lib/app-session.ts apps/web/src/app/login/page.tsx \
  apps/web/src/components/session-home.tsx apps/web/e2e apps/web/test/product-shell.test.ts \
  apps/web/package.json packages/config/test/turbo.test.ts packages/ui/src/tokens.css
git commit -m "feat(web): add authenticated product shell"
```

### Task 3: Prompt dashboard and real recent-project gallery

**Files:**
- Create: `apps/web/src/components/projects/project-card-view.ts`
- Create: `apps/web/src/components/projects/project-thumbnail.ts`
- Create: `apps/web/src/components/projects/ProjectThumbnail.tsx`
- Create: `apps/web/src/components/projects/useProjectDashboard.ts`
- Create: `apps/web/src/components/home/RecentProjects.tsx`
- Modify: `apps/web/src/components/home/Hero.tsx`
- Modify: `apps/web/src/components/home/home.module.css`
- Modify: `apps/web/src/components/projects/ProjectCard.tsx`
- Modify: `apps/web/src/components/session-home.tsx`
- Modify: `apps/web/e2e/home.spec.ts`
- Modify: `apps/web/test/product-shell.test.ts`

**Interfaces:**
- Produces: `toProjectCardView(project, summary): ProjectCardView`.
- Produces: `decodeThumbnail(response): Blob` with MIME allowlist and content-hash verification already performed server-side.
- Produces: `useProjectDashboard({ organizationId, limit })` with generation fencing, abort, bounded six-at-a-time thumbnail loading, and object-URL cleanup.

- [ ] **Step 1: Write view-model and browser RED tests**

In `product-shell.test.ts`, test exact mapping for missing activity, Preview starting/ready/failed, Production deploying/healthy/failed, readiness, missing thumbnail, allowed MIME decoding, and object-URL revocation. In `home.spec.ts`, return two projects and summaries, mock one thumbnail response, and assert My projects, thumbnail alt text, fallback artwork, status text, Open, and Browse all.

Expected RED command:

```bash
pnpm --filter @zapp/web exec playwright test e2e/home.spec.ts
pnpm --filter @zapp/web exec tsx --test test/product-shell.test.ts
```

- [ ] **Step 2: Implement pure projection and thumbnail lifecycle**

`project-thumbnail.ts` converts allowed base64 content to a Blob and exposes `revokeThumbnail(url)`. `useProjectDashboard.ts` loads one project page, then one batch summary, then thumbnails with an `AbortController` per generation. Revoke old URLs on organization change and unmount.

- [ ] **Step 3: Compose the reference dashboard**

Keep the prompt composer centered in the gradient. Add a raised My projects panel below suggestions. Use two columns at desktop and one on mobile. Cards show real thumbnail/fallback, name, support level, last activity, Preview, Production, readiness, and Open. Browse all links to `/projects`.

- [ ] **Step 4: Verify retry and stale-response behavior**

Add browser cases for failed recent reads with Retry, summary failure preserving base cards, an Alpha to Beta switch that rejects Alpha thumbnails, and object URL revocation through a page-side spy.

```bash
pnpm --filter @zapp/web exec playwright test e2e/home.spec.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

- [ ] **Step 5: Commit the dashboard slice**

```bash
git add apps/web/src/components/home apps/web/src/components/projects \
  apps/web/src/components/session-home.tsx apps/web/e2e/home.spec.ts \
  apps/web/test/product-shell.test.ts
git commit -m "feat(web): add prompt dashboard project gallery"
```

### Task 4: Full projects workspace restyle

**Files:**
- Modify: `apps/web/src/components/projects/ProjectsDashboard.tsx`
- Modify: `apps/web/src/components/projects/ProjectCard.tsx`
- Modify: `apps/web/src/components/projects/projects.module.css`
- Modify: `apps/web/src/app/projects/page.tsx`
- Modify: `apps/web/e2e/projects.spec.ts`

**Interfaces:**
- Consumes: `AppShell`, `useAppSession`, `toProjectCardView`, `ProjectThumbnail`, existing paginated project operations, summary batches, and GitHub import operations.
- Preserves: current request generation, pagination dedupe, import identity, and retry idempotency behavior.

- [ ] **Step 1: Add visual-structure RED assertions without weakening existing races**

Extend `projects.spec.ts` to assert the shared shell, workspace heading, responsive card grid, real status labels, thumbnail/fallback, New project, Import from GitHub, Browse templates, loading announcement, and the existing Alpha to Beta to Alpha pagination race.

- [ ] **Step 2: Replace the sparse page frame**

Render `ProjectsDashboard` inside `AppShell`. Move organization selection into the shared shell but keep the existing request-generation reset. Add a compact workspace toolbar and reference-style card grid. Preserve the full existing GitHub import dialog and New project composer.

- [ ] **Step 3: Verify all existing project behaviors**

```bash
pnpm --filter @zapp/web exec playwright test e2e/projects.spec.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

Expected: every pre-existing projects test plus new shell/card assertions passes.

- [ ] **Step 4: Commit the workspace slice**

```bash
git add apps/web/src/app/projects apps/web/src/components/projects apps/web/e2e/projects.spec.ts
git commit -m "feat(web): restyle projects workspace"
```

### Task 5: Extract API-backed settings modules

**Files:**
- Create: `apps/web/src/components/settings/settings-types.ts`
- Create: `apps/web/src/components/settings/integration-catalog.ts`
- Create: `apps/web/src/components/settings/useProjectSettings.ts`
- Create: `apps/web/src/components/settings/SettingsLayout.tsx`
- Create: `apps/web/src/components/settings/GeneralSettings.tsx`
- Create: `apps/web/src/components/settings/SecretsSettings.tsx`
- Create: `apps/web/src/components/settings/IntegrationsSettings.tsx`
- Create: `apps/web/src/components/settings/IntegrationConnectDialog.tsx`
- Create: `apps/web/src/components/settings/MembersSettings.tsx`
- Create: `apps/web/src/components/settings/GitHubSettings.tsx`
- Create: `apps/web/src/components/settings/PaymentsSettings.tsx`
- Create: `apps/web/src/components/settings/settings.module.css`
- Modify: `apps/web/src/components/settings/ProjectSettings.tsx`
- Modify: `apps/web/e2e/settings.spec.ts`
- Modify: `apps/web/test/product-shell.test.ts`

**Interfaces:**
- Produces: `ProjectSettingsSection = 'general' | 'secrets' | 'integrations' | 'payments' | 'members' | 'github'`.
- Produces: typed `INTEGRATION_CATALOG` for GitHub, Supabase, Neon, Stripe, and Vercel only.
- Produces: `ProjectSettingsPanel({ projectId, section, embedded })` used by routes and builder Manage.
- Consumes: existing integration, secret, member, GitHub, organization setting, project update/delete, and billing SDK operations.

- [ ] **Step 1: Write owner/viewer and provider RED tests**

Add exact catalog/category/field assertions to `product-shell.test.ts`. Expand `settings.spec.ts` to cover all five catalog cards, exact connection status, Connect dialog, Disconnect, credential clearing, project Stripe versus account Billing copy, owner-only members, builder project controls, viewer read-only state, and deep-link navigation.

Assert unsupported provider names have count zero.

- [ ] **Step 2: Move metadata and controller state into TypeScript**

Define catalog entries with exact field descriptors:

```ts
export interface IntegrationCatalogEntry {
  readonly provider: 'github' | 'supabase' | 'neon' | 'stripe' | 'vercel';
  readonly category: 'source' | 'data' | 'payments' | 'deployment';
  readonly title: string;
  readonly description: string;
  readonly fields: readonly IntegrationField[];
}
```

`useProjectSettings.ts` owns session/project/role loading, abort fencing, public reads, mutation status, and bounded reconciliation. It never stores a submitted credential after the request settles.

- [ ] **Step 3: Extract one focused component per section**

Replace the monolithic inline-styled `ProjectSettings` with `SettingsLayout` and focused section components. `IntegrationsSettings` renders the card grid; `IntegrationConnectDialog` renders provider-specific fields and dispatches the existing generated operation. `PaymentsSettings` renders only the project Stripe connection and links account billing separately.

- [ ] **Step 4: Prove secret and credential non-disclosure**

Keep the existing network-level secret assertion. Add provider credential assertions covering successful and failed requests. After submission, the field must be empty and the value must not appear in DOM, recorded response bodies, console messages, or analytics requests.

- [ ] **Step 5: Verify settings and commit**

```bash
pnpm --filter @zapp/web exec playwright test e2e/settings.spec.ts
pnpm --filter @zapp/web exec tsx --test test/product-shell.test.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

```bash
git add apps/web/src/components/settings apps/web/e2e/settings.spec.ts \
  apps/web/test/product-shell.test.ts
git commit -m "feat(web): extract real API settings modules"
```

### Task 6: Builder Preview and Manage composition

**Files:**
- Create: `apps/web/src/components/builder/builder-navigation.ts`
- Create: `apps/web/src/components/builder/WorkingSurface.tsx`
- Create: `apps/web/src/components/builder/ManageSurface.tsx`
- Create: `apps/web/src/components/builder/builder.module.css`
- Modify: `apps/web/src/components/builder/Shell.tsx`
- Modify: `apps/web/src/components/builder/TopBar.tsx`
- Modify: `apps/web/src/components/builder/SurfaceTabs.tsx`
- Modify: `apps/web/src/components/conversation/Thread.tsx`
- Modify: `apps/web/src/components/conversation/Composer.tsx`
- Modify: `apps/web/e2e/builder-shell.spec.ts`
- Modify: `apps/web/e2e/conversation.spec.ts`
- Modify: `apps/web/e2e/settings.spec.ts`
- Modify: `apps/web/test/product-shell.test.ts`

**Interfaces:**
- Produces: `BuilderMode = 'preview' | 'manage'` and `ManageSection = ProjectSettingsSection`.
- Produces: `parseBuilderNavigation(searchParams)` and `serializeBuilderNavigation(state)` for reload/share-safe query state.
- Consumes: `ProjectSettingsPanel` from Task 5 and all existing Preview, Files, Code, Logs, Tests, Releases, Health, Mission Control, and Deploy components.

- [ ] **Step 1: Add navigation reducer RED tests**

Test default Preview, valid Manage section, unknown query fallback, Preview sub-tab restoration, and mobile Conversation/Workspace selection in `product-shell.test.ts`. In Playwright, assert Preview and Manage top-level controls, canonical settings links, no navigation on embedded selection, and URL restoration after reload.

- [ ] **Step 2: Build the working-surface composition**

`WorkingSurface` renders the top-level segmented control. Preview renders Preview, Files, Code, and More; More gives direct access to Logs, Tests, Releases, and Health without copying their state. Manage renders `ProjectSettingsPanel` with `embedded` true.

Keep the current pane width persistence and separator semantics. Do not unmount the active conversation when switching the right surface.

- [ ] **Step 3: Refine project header and conversation density**

Apply the reference hierarchy to project identity, save/run state, environment, GitHub, Deploy, Mission Control, and settings. Keep all current enablement rules. Tighten message/card spacing and pin the composer without changing event reduction or mutation behavior.

- [ ] **Step 4: Verify desktop and mobile behavior**

At 1440 pixels assert sidebar, conversation, and surface are visible. At 1180 assert rail plus both builder panes. At 900 assert the Conversation/Workspace switcher and navigation drawer. Verify pointer and keyboard pane resizing remain green.

```bash
pnpm --filter @zapp/web exec playwright test e2e/builder-shell.spec.ts e2e/conversation.spec.ts e2e/settings.spec.ts
pnpm --filter @zapp/web exec tsx --test test/product-shell.test.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

- [ ] **Step 5: Commit the builder slice**

```bash
git add apps/web/src/components/builder apps/web/src/components/conversation \
  apps/web/e2e/builder-shell.spec.ts apps/web/e2e/conversation.spec.ts apps/web/e2e/settings.spec.ts \
  apps/web/test/product-shell.test.ts
git commit -m "feat(web): add preview and manage builder surfaces"
```

### Task 7: Shell coverage for account, release, and health routes

**Files:**
- Create: `apps/web/src/components/shell/PageFrame.tsx`
- Modify: `apps/web/src/app/org/usage/page.tsx`
- Modify: `apps/web/src/app/org/billing/page.tsx`
- Modify: `apps/web/src/app/org/audit/page.tsx`
- Modify: `apps/web/src/components/releases/ReleasesView.tsx`
- Modify: `apps/web/src/components/releases/ProductionHealthView.tsx`
- Modify: `apps/web/src/components/templates/TemplateGallery.tsx`
- Modify: `apps/web/src/components/templates/templates.module.css`
- Modify: `apps/web/e2e/org-settings.spec.ts`
- Modify: `apps/web/e2e/releases.spec.ts`
- Modify: `apps/web/e2e/templates.spec.ts`

**Interfaces:**
- Produces: `PageFrame({ eyebrow, title, description, actions, children })` for consistent content hierarchy.
- Consumes: `AppShell`, existing SDK-backed route components, and their current permission rules.

- [ ] **Step 1: Add shell and hierarchy RED assertions**

Extend the focused Playwright suites to assert shared navigation, page title/description, loading status, real empty/error states, and unchanged public requests for Usage, Billing, Audit, Templates, Releases, and Health.

- [ ] **Step 2: Wrap and restyle without changing contracts**

Use `PageFrame` and existing tokens. Convert raw inline layout to CSS Modules where touched. Preserve all billing checkout/portal idempotency, release actions, rollback safety, template Remix, and health Fix-run behavior.

- [ ] **Step 3: Verify and commit route coverage**

```bash
pnpm --filter @zapp/web exec playwright test \
  e2e/org-settings.spec.ts e2e/releases.spec.ts e2e/templates.spec.ts e2e/health.spec.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
```

```bash
git add apps/web/src/components/shell/PageFrame.tsx apps/web/src/app/org \
  apps/web/src/components/releases apps/web/src/components/templates apps/web/e2e
git commit -m "feat(web): unify account and release surfaces"
```

### Task 8: Accessibility, connected acceptance, and task closure

**Files:**
- Modify: `apps/web/e2e/accessibility.spec.ts`
- Modify: `apps/web/e2e/e1-journey.spec.ts` only if selectors need semantic alignment, never to weaken assertions or replace real calls
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: every prior task output.
- Produces: final WEB-18 acceptance evidence and tracker/log closure.

- [ ] **Step 1: Run focused visual and accessibility review round 1**

Inspect home, projects, builder Preview, builder Manage, login, Billing, and mobile builder at 1440x950, 1180x800, 900x900, and 390x844. Record only correctness, accessibility, responsive, API-truth, or material reference-fidelity defects. Fix accepted findings test-first.

- [ ] **Step 2: Run local review round 2**

Repeat the local focused suites and visual inspection once. At the two-round cap, re-scope any non-blocking polish into an execution-log note. Do not run a real provider during either review.

- [ ] **Step 3: Run the complete local task gate**

```bash
pnpm --filter @zapp/control-api test -- project-summaries.test.ts openapi.test.ts openapi-contract.test.ts
pnpm --filter @zapp/control-api test:integration -- projects.test.ts
pnpm --filter @zapp/api-client test
pnpm --filter @zapp/ui test:unit
pnpm --filter @zapp/web exec playwright test
pnpm --filter @zapp/control-api lint
pnpm --filter @zapp/control-api typecheck
pnpm --filter @zapp/api-client lint
pnpm --filter @zapp/api-client typecheck
pnpm --filter @zapp/ui lint
pnpm --filter @zapp/ui typecheck
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
pnpm --filter @zapp/web build
```

Expected: every command exits 0. A failed check remains failed and blocks closure.

- [ ] **Step 4: Run connected and credential-gated acceptance once**

```bash
pnpm --filter @zapp/web exec playwright test e2e/e1-journey.spec.ts
pnpm --filter @zapp/control-api test:integration -- auth.test.ts
```

Expected: E1 passes from public login through deployment. Stytch passes when configured, or visibly skips with the exact missing environment names. Do not report a skip as a pass.

- [ ] **Step 5: Run repository gate and close WEB-18**

Run `pnpm verify`. If build wiring or generated SDK wiring changed in a way that can be hidden by stale output, run `pnpm verify:cold` before any push.

Only after green output:

- Check WEB-18 in `tasks/todo.md`.
- Check every WEB-18 step in Plan 08.
- Append `2026-08-13 WEB-18 done - ...` to Plan 08's Execution log with exact verification totals, skips, blockers, and deviations.

- [ ] **Step 6: Commit closure**

```bash
git add apps/web/e2e/accessibility.spec.ts apps/web/e2e/e1-journey.spec.ts \
  docs/plans/08-web-ux.md tasks/todo.md
git commit -m "feat(web): complete real API product shell"
```
