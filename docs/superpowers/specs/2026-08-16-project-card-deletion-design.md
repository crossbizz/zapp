# Project Card Deletion Design

**Status:** Approved by the product owner on 2026-08-16. The product owner delegated remaining implementation decisions and requested no further questions.

## Problem

The control plane already provides an Owner-only, idempotency-keyed asynchronous deletion API and status read. The project Settings screen consumes the delete operation, but the Projects dashboard shown by the product owner exposes no deletion action on each card. Users therefore cannot manage unwanted projects where they naturally encounter them.

## Chosen design

Add an Owner-only overflow menu to every project card. The menu contains **Delete project**. Selecting it opens a controlled confirmation dialog that requires the exact project name, matching the existing Settings safeguard.

This is a web consumer of the existing `/v1` API. No duplicate route, browser-private deletion state, synchronous-delete claim, or backend deletion behavior is introduced.

## Interaction

1. An Owner opens a project card's overflow menu and selects **Delete project**.
2. A dialog names the project, explains that deletion removes source, artifacts, snapshots, and project data asynchronously, and requires the exact project name.
3. Confirm sends the existing keyed `DELETE /v1/projects/:projectId` request.
4. The card immediately enters a truthful **Deleting…** state: Open and repeated deletion are disabled, while other cards remain usable.
5. The dashboard polls the existing deletion-status endpoint with bounded backoff while the page remains mounted.
6. `completed` removes the card and its summary/thumbnail state. `failed` keeps the card visible with **Deletion failed** and a Retry action that uses a new idempotency key. `queued` and `running` remain visibly in progress.

Builders and Viewers do not receive the overflow deletion action. The existing Settings action remains available and shares the same API behavior.

## Component boundaries

- `ProjectCard` renders the menu trigger and deletion state but does not own network orchestration.
- `DeleteProjectDialog` owns confirmation input and accessible dialog content.
- `ProjectsDashboard` owns the tenant-scoped delete request, polling lifecycle, project removal, thumbnail revocation, and per-card errors.
- A small deletion-state type records `idle | confirming | requesting | queued | running | failed`; `completed` removes the card instead of becoming a persistent client state.

No project-card visual redesign, archive behavior change, or deletion-pipeline change is in scope.

## Error handling

- A 403/404 closes the optimistic transition, leaves the card visible, and shows a role/not-found-safe error.
- Network failure preserves the confirmed dialog state and permits a safe retry with the same key until the server outcome is known.
- An accepted deletion is never reported as complete until the status API returns `completed` or the project list no longer contains the tenant-scoped project.
- Organization switching aborts every deletion poll and clears the old tenant's card state.
- Thumbnail object URLs are revoked exactly once when a completed project is removed.

## Tests and acceptance

- Owner sees Delete on every card; Builder and Viewer do not.
- Confirmation remains disabled until the exact project name is entered.
- The request carries organization context, CSRF, and an idempotency key.
- Accepted deletion disables Open and shows Deleting.
- Queued/running polling continues without duplicate requests; completed removes only the target card.
- Failed deletion exposes Retry without affecting other cards.
- Organization switching aborts stale polling and prevents cross-tenant UI mutation.
- Existing project pagination, summary retries, thumbnails, imports, and new-project behavior stay green.
- Focus returns predictably when the dialog closes, and the flow passes the existing accessibility suite.

Verify with focused project-dashboard Playwright tests, web lint/typecheck/build, and the owning task's repository gate. No real-provider call is required.
