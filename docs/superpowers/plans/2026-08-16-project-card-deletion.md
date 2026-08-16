# Project Card Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let project Owners safely delete any project from its dashboard card while showing the existing asynchronous deletion lifecycle truthfully.

**Architecture:** Reuse the existing owner-only `/v1` deletion request and status API, extending its failed-row contract so an explicit retry can safely claim a fresh key under a tenant-scoped lock. Keep network and polling state in `ProjectsDashboard`, confirmation content in a focused dialog, and presentation/disabled state in `ProjectCard`; remove a card only after the server reports completion or the tenant-scoped list no longer contains it.

**Tech Stack:** TypeScript 5.6, generated `@zapp/api-client`, Next.js 15, React 19, `@zapp/ui`, Playwright.

## Global Constraints

- This is a public-SDK consumer; no UI-private endpoint or browser-only deletion authority is added.
- Only organization Owners see the action; Builders and Viewers do not receive it.
- The exact project name is required before confirmation.
- The idempotency key is stable across retries while the server outcome is unknown and new after an explicit failed deletion retry.
- The UI never reports completion before deletion status is `completed` or a fresh scoped list omits the project.
- Organization changes abort polling and clear stale per-card state.
- Existing unrelated user edits stay untouched.
- No provider call is required.

---

### Task 1: WEB-20 project-card deletion lifecycle

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/projects/DeleteProjectDialog.tsx`
- Modify: `apps/web/src/components/projects/ProjectCard.tsx`
- Modify: `apps/web/src/components/projects/ProjectsDashboard.tsx`
- Modify: `apps/web/src/components/projects/projects.module.css`
- Test: `apps/web/e2e/projects.spec.ts`
- Modify: `services/control-api/src/jobs/deletion.ts`
- Test: `services/control-api/test/deletion.test.ts`
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: existing `deleteProject(projectId, key)`, public `GET /v1/projects/:projectId/deletion`, ready session membership role, project-card thumbnail cleanup helpers.
- Produces: `DeleteProjectDialog`, per-project `ProjectDeletionState`, Owner-only card overflow action, bounded deletion polling.

- [x] **Step 1: Write failing Owner/RBAC/confirmation Playwright tests**

```ts
test('Owner deletes one project card through the asynchronous public lifecycle', async ({ page }) => {
  await openProjectsAs(page, 'Owner');
  await page.getByRole('button', { name: 'Project actions for Alpha Portal' }).click();
  await page.getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByRole('button', { name: 'Delete Alpha Portal' })).toBeDisabled();
  await page.getByLabel('Project name').fill('Alpha Portal');
  await page.getByRole('button', { name: 'Delete Alpha Portal' }).click();
  await expect(page.getByRole('article', { name: 'Alpha Portal' })).toContainText('Deleting…');
  await expect(page.getByRole('heading', { name: 'Alpha Portal' })).toHaveCount(0);
});

test('Builder and Viewer do not receive project deletion actions', async ({ page }) => {
  await openProjectsAs(page, 'Builder');
  await expect(page.getByRole('button', { name: /Project actions/u })).toHaveCount(0);
});
```

Add assertions for request organization/CSRF/idempotency headers, queued→running polling without duplicate timers, failed→Retry with a new key, other cards remaining usable, and organization-switch abort fencing.

- [x] **Step 2: Run focused project tests to verify RED**

Run: `pnpm --filter @zapp/web exec playwright test e2e/projects.spec.ts --grep "delete|deletion"`

Expected: FAIL because project cards have no deletion action or lifecycle state.

- [x] **Step 3: Add the typed status wrapper and confirmation dialog**

```ts
export type ProjectDeletionState =
  | { readonly status: 'idle' }
  | { readonly status: 'confirming' }
  | { readonly status: 'requesting'; readonly operationKey: string }
  | { readonly status: 'queued' | 'running'; readonly operationKey: string }
  | { readonly status: 'reconciling'; readonly operationKey: string; readonly message: string }
  | { readonly status: 'failed'; readonly message: string };
```

`DeleteProjectDialog` receives `{ projectName, open, busy, error, onCancel, onConfirm }`, owns the controlled exact-name field, resets it on close/project change, uses `role="dialog"`/`aria-modal="true"`, and returns focus to the card action trigger.

- [x] **Step 4: Wire Owner-only card actions and dashboard orchestration**

```tsx
<ProjectCard
  canDelete={session.snapshot.membership.role === 'Owner'}
  deletionState={deletions.get(project.id) ?? { status: 'idle' }}
  onDelete={() => beginDelete(project)}
  onRetryDelete={() => requestDelete(project, crypto.randomUUID())}
  {...existingProps}
/>
```

On confirmation, call the existing DELETE route with a stable key, set the accepted server status, and poll status at bounded 500 ms → 1 s → 2 s intervals. Continue reconciling an explicit worker failure because the worker may recover automatically; allow a fresh-key retry only while the row is still failed. On completion, revoke/remove only the target thumbnail, summary, error, loading, and project entries. Abort all timers/controllers and clear deletion state when the organization generation changes.

- [x] **Step 5: Run project suite to verify GREEN**

Run: `pnpm --filter @zapp/web exec playwright test e2e/projects.spec.ts`

Expected: all dashboard pagination, import, thumbnail, summary retry, and deletion tests pass.

- [x] **Step 6: Run web gates**

Run: `pnpm --filter @zapp/web lint && pnpm --filter @zapp/web typecheck && pnpm --filter @zapp/web build && git diff --check`

Expected: lint, typecheck, production build, and whitespace checks pass.

- [x] **Step 7: Record and commit WEB-20**

Append the WEB-20 execution-log line, check WEB-20 in `tasks/todo.md`, and commit:

```bash
git add apps/web/src/lib/api.ts apps/web/src/components/projects apps/web/e2e/projects.spec.ts services/control-api/src/jobs/deletion.ts services/control-api/test/deletion.test.ts docs/plans/08-web-ux.md tasks/todo.md
git commit -m "feat(web): add project-card deletion"
```
