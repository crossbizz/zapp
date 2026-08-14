# Immersive Builder Repair Implementation Plan

> **Task:** WEB-18-FIX-3  
> **Design:** `docs/superpowers/specs/2026-08-13-immersive-builder-repair-design.md`

## Files

**Create:**

- `docs/superpowers/specs/2026-08-13-immersive-builder-repair-design.md`
- `docs/superpowers/plans/2026-08-13-immersive-builder-repair.md`

**Modify:**

- `apps/web/src/components/shell/AppShell.tsx`
- `apps/web/src/components/shell/shell.module.css`
- `apps/web/src/components/builder/Shell.tsx`
- `apps/web/src/components/builder/BuilderDeploy.tsx`
- `apps/web/src/components/builder/SurfaceTabs.tsx`
- `apps/web/src/components/builder/TopBar.tsx`
- `apps/web/src/components/builder/WorkingSurface.tsx`
- `apps/web/src/components/builder/builder.module.css`
- `apps/web/src/components/conversation/Thread.tsx`
- `apps/web/src/components/conversation/Composer.tsx`
- `apps/web/src/components/preview/PreviewFrame.tsx`
- `apps/web/src/components/preview/PreviewToolbar.tsx`
- `apps/web/src/components/preview/SelectMode.tsx`
- `apps/web/e2e/builder-shell.spec.ts`
- `apps/web/e2e/accessibility.spec.ts`
- `apps/web/e2e/conversation.spec.ts`
- `apps/web/e2e/preview-panel.spec.ts`
- `docs/plans/08-web-ux.md`
- `tasks/todo.md`

No desktop file is in scope.

`accessibility.spec.ts` was added during final verification because its builder-only
expectations still required the product sidebar that this task explicitly removes.

## Task 1 — Accepted prompts have immediate truthful feedback

- [x] **RED:** Add a Playwright case where the project has no runs, `POST /v1/projects/:projectId/runs` returns a queued run, and its SSE endpoint stays empty. Assert the submitted prompt remains visible, a queued status is announced, the composer clears, and Stop becomes available. Run it and confirm it fails because the current event-only thread is empty.
- [x] **RED:** Extend the case with a later matching `message.user` event and assert the prompt appears exactly once. Confirm the current implementation cannot satisfy the accepted-with-no-event state.
- [x] **GREEN:** Add occurrence-ordinal optimistic user messages to `Thread`, append only after a successful public SDK response, and reconcile them against durable user events without parsing assistant prose.
- [x] **GREEN:** Render an accessible queued/running state from the adopted run and existing structured events. Preserve the current failure behavior, composer content, and retry-stable idempotency identities.
- [x] **VERIFY:** Run the focused conversation cases and the full conversation spec.

## Task 2 — Replace the nested product shell with an immersive builder

- [x] **RED:** Update the desktop shell acceptance to assert that the builder does not render the product sidebar, the top bar is at most 56px high, the conversation pane is 400–520px at 1440px, the workspace is wider than the conversation, and the composer remains inside the viewport.
- [x] **RED:** Assert there is one `Preview | Files | Code | More` workspace tablist and one header-level `Preview | Manage` mode control, not a floating nested mode card.
- [x] **GREEN:** Add an explicit immersive variant to `AppShell`, use it only for the builder, and place the home/project affordance in `TopBar`.
- [x] **GREEN:** Compact the top bar, constrain the conversation width while preserving pointer/keyboard persistence, remove pane outer padding, and make the thread/composer height-bounded.
- [x] **GREEN:** Move the mode switch into `TopBar`; keep `WorkingSurface` responsible only for rendering the selected surface.
- [x] **VERIFY:** Run builder shell desktop, resize, URL restoration, Mission Control, and responsive tests.

## Task 3 — Make preview chrome compact and dominant

- [x] **RED:** Extend preview acceptance with toolbar/stage geometry and a queued-run empty state. Assert route/device/actions/selection fit in the compact preview header and the stage occupies the remaining panel height.
- [x] **GREEN:** Consolidate preview controls into the compact toolbar, convert secondary actions to icon-sized accessible controls, and remove the separate selection row.
- [x] **GREEN:** Restyle the empty/starting/live states so the stage fills the workspace and no oversized bordered empty card is rendered.
- [x] **VERIFY:** Run preview panel, preview share, element selection, console attachment, and responsive acceptance.

## Task 4 — Final verification and shipment

- [x] Run `pnpm --filter @zapp/web lint` and `pnpm --filter @zapp/web typecheck`.
- [x] Run the complete web test command and build.
- [x] Start the complete development stack on the configured ports, verify all required services are healthy, and run the authenticated prompt -> queued/running -> first event -> preview transition in the browser. If a provider dependency is absent, report it as unverified rather than converting it into a pass.
- [x] Run accessibility and 1440px/1180px/mobile visual acceptance with fresh screenshots.
- [x] Run `pnpm verify` from the exact working tree, then verify committed `HEAD` from a clean checkout before pushing.
- [x] Check `WEB-18-FIX-3` in `tasks/todo.md`, append the execution-log line in `docs/plans/08-web-ux.md`, commit `fix(web): repair immersive builder prompt and preview flow`, push `main`, and confirm exact-head GitHub CI and Security are green.
