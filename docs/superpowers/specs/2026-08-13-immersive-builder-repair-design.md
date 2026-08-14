# Immersive Builder Repair Design

**Date:** 2026-08-13
**Task:** WEB-18-FIX-3

## Outcome

The project builder becomes an immersive, compact editor modeled on the interaction density of Lovable and Base44 while retaining zapp.build's existing public API, generated SDK, structured SSE events, preview security boundary, Mission Control, and deployment workflow.

The repair also closes the observed dead-feedback path: a prompt that the API accepts as a queued run must appear in the conversation immediately, even before the orchestrator emits its first `message.user` event. When that event arrives, the optimistic copy reconciles without duplication.

## Evidence and diagnosis

- At a 1728px reference viewport, Base44 holds the conversation surface to roughly 450px, uses a single roughly 51px editor header, and gives the remaining space to the preview.
- Lovable follows the same dominant-preview model: compact project chrome, a bounded chat surface, and a composer anchored to the bottom.
- The current zapp.build builder combines a 248px product sidebar, a 40%-of-remainder conversation pane, a 72px project header, a separate Preview/Manage switcher, another surface-tab row, and a padded preview toolbar. This produces the oversized nested layout in the reported screenshot.
- The reported prompt did reach the real API. PostgreSQL contains a new `build` run in `queued` state, but it has no events. The thread renders user text only from `message.user` SSE events, so the composer clears and the screen appears unchanged. The local model gateway was also absent on port 4100, leaving the accepted run queued.

## Approaches considered

### 1. Visual reskin only

Reduce padding and font sizes without changing composition or state handling.

Rejected because the prompt would still disappear before the first event and the nested sidebar/header/tab hierarchy would remain.

### 2. Immersive composition repair — selected

Keep all existing API and builder capabilities, but give the builder its own full-width editor composition, consolidate navigation, bound the chat column, simplify preview chrome, and add explicit accepted/queued feedback.

Selected because it fixes the observed behavior and hierarchy without replacing stable backend contracts.

### 3. Ground-up builder rewrite

Replace conversation, preview, Manage, Mission Control, and deployment composition.

Rejected because it creates unnecessary regression risk across already-shipped contracts and would delay the user-visible repair.

## Layout

### Desktop (>= 1024px)

- The authenticated product sidebar is not rendered inside the builder route. The editor owns the full viewport, as in the reference editors.
- A 52px top bar contains: zapp.build/home affordance, project identity and support status, centered `Preview | Manage` mode controls, then compact GitHub, deploy, Mission Control, and settings actions.
- The split area fills the remaining viewport height.
- Conversation defaults to 30% of the editor width, clamped to 400–520px. Existing resize persistence remains, but the rendered width cannot grow into the oversized state shown in the report.
- The divider is 5–6px with a subtle hover/focus affordance.
- The workspace receives the remaining width and has no outer 20px padding.

### Conversation

- The thread is a height-bounded flex column. Messages scroll independently; the composer remains anchored at the bottom.
- Body text remains 14px, metadata/status text 12px, and controls are 32–36px high.
- User messages use a compact neutral bubble. Agent messages remain visually open to preserve markdown readability.
- A successful send immediately adds a pending user bubble and a live `Build queued` status when the returned run is queued.
- Pending bubbles reconcile by occurrence ordinal when matching `message.user` events arrive, so repeated identical prompts remain correct and no duplicate appears.
- Failures preserve the message in the composer and expose the existing retry-safe error.

### Workspace and preview

- `Preview | Files | Code | More` remains the single workspace tab row. `Preview | Manage` moves to the editor header, eliminating the duplicate floating switcher.
- Preview uses one compact 44–48px toolbar: environment, route, device controls, open, refresh, share, and element selection.
- Device controls and secondary actions use compact accessible labels/icons instead of large text buttons.
- The preview stage fills available height on a quiet neutral canvas. The iframe is white and centered at the selected device width.
- Before a workspace exists, the empty state is borderless and compact, with copy tied to the current run: queued runs say the builder is preparing the workspace; a truly idle project invites the user to start with the composer.
- Existing starting, sleeping, stale, disconnected, failed, console, selection, share, and Fix flows retain their public SDK behavior.

## Responsive behavior

- Below 1024px the existing Conversation/Workspace bottom switcher remains. The product navigation is available through the builder's home/project affordance rather than consuming horizontal space.
- The top bar wraps only secondary actions and keeps the primary mode control reachable.
- Preview toolbar controls wrap into compact rows without making the stage narrower than necessary.

## Functional state flow

1. User submits a non-empty message.
2. Existing generated-SDK upload and create/continue operations run with their retry-stable keys.
3. On accepted response, the thread appends an optimistic user message, clears the composer, adopts the returned run, and announces queued/running state.
4. Structured SSE events continue to be the durable source for agent text, tools, phases, commits, cards, preview lifecycle, and terminal state.
5. When a matching `message.user` event is observed, the corresponding optimistic item disappears without changing ordering of durable events.
6. If the request fails, no optimistic success is shown; the input remains available and the existing safe retry identity is retained.

## Verification boundaries

- Playwright proves accepted-with-no-events feedback, later event reconciliation, compact desktop geometry, the absence of the product sidebar inside the builder, one workspace navigation hierarchy, responsive pane switching, and the existing preview actions.
- Browser verification runs against the real authenticated localhost flow with the full development stack healthy. A queued run with a missing gateway/worker is reported as queued, not as a successful build.
- No provider call is made during review rounds. One real-provider run occurs only at the final acceptance gate when the configured stack is healthy.

