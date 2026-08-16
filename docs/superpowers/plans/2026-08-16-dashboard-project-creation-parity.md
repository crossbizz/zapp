# Dashboard Project Creation Parity Implementation Plan

> **Execution note:** Implement this plan with TDD, keep the public API unchanged, and preserve unrelated workspace edits.

**Goal:** Match the approved Lovable project-creation flow: concise generated project names, a canonical `/dashboard` prompt surface, no non-actionable support badge, and a cleaner prompt composer.

**Architecture:** Keep project creation on the existing public `POST /v1/projects` and `POST /v1/projects/:id/runs` APIs. Extract deterministic title derivation into a pure web utility, route project entry points to the existing authenticated home surface at `/dashboard`, and remove only the support-level presentation while retaining the API field.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS Modules, Node test runner, Playwright.

---

### Task 1: Lock the concise-title and canonical-dashboard contracts

**Files:**
- Create: `apps/web/src/lib/project-title.ts`
- Create: `apps/web/test/project-title.test.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/e2e/home.spec.ts`
- Modify: `apps/web/e2e/e1-journey.spec.ts`
- Modify: `apps/web/e2e/projects.spec.ts`
- Modify: `apps/web/e2e/web-1.spec.ts`
- Modify: `apps/web/test/product-shell.test.ts`

1. Add failing pure tests for deterministic three-to-four-word titles and filler removal.
2. Add failing browser assertions that dashboard navigation targets `/dashboard`, project CTAs link there, and support badges do not render.
3. Run the focused tests and confirm they fail for the intended missing behavior.

### Task 2: Implement the public-API-backed creation flow

**Files:**
- Modify: `apps/web/src/components/home/PromptComposer.tsx`
- Modify: `apps/web/src/components/session-home.tsx`
- Create: `apps/web/src/app/dashboard/page.tsx`
- Modify: `apps/web/src/components/shell/shell-navigation.ts`
- Modify: `apps/web/src/components/shell/Sidebar.tsx`
- Modify: `apps/web/src/components/shell/AppShell.tsx`
- Modify: `apps/web/src/components/projects/ProjectsDashboard.tsx`
- Replace: `apps/web/src/components/projects/NewProjectDialog.tsx` with `NewProjectLink.tsx`
- Modify: `apps/web/src/components/projects/ProjectCard.tsx`

1. Derive a title from meaningful prompt words, cap it at four words, and preserve the complete prompt for the first run.
2. Make `/dashboard` render the existing authenticated creation surface and update dashboard/brand links to the canonical route.
3. Replace project-page creation dialogs with direct links to `/dashboard`.
4. Remove support-level badges from project cards without changing API schemas or stored metadata.

### Task 3: Match the approved composer visual rhythm

**Files:**
- Modify: `apps/web/src/components/home/home.module.css`
- Modify: `apps/web/src/components/projects/projects.module.css`
- Modify: `apps/web/e2e/home.spec.ts`

1. Remove the textarea’s blue inset border while retaining a visible neutral focus treatment on the complete composer.
2. Collapse the empty chip row and align textarea/action-row padding with the approved reference.
3. Keep keyboard order, labels, and disabled-submit behavior intact.

### Task 4: Verify and ship

**Files:**
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

1. Run focused Node and Playwright tests, web lint/typecheck/build, and local browser visual/accessibility checks.
2. Run `pnpm verify`, then record WEB-22 completion in the binding plan and tracker in the task commit.
3. Push `main` and require the exact pushed SHA to pass GitHub Actions.
