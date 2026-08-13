# Real API Product Shell and Builder UI Design

**Date:** 2026-08-13
**Status:** Approved by product owner
**Owner:** Plan 08, Web App & UX

## Context

The P0 web application already has the required product surfaces and public API contracts. The prompt home, projects dashboard, two-pane builder, typed conversation cards, preview, code, logs, tests, Mission Control, settings, integrations, billing, release, health, and deployment flows exist. A connected Playwright journey also proves the public API path from sign-in through deployment.

The missing part is product composition and visual quality. The current home is close to the supplied Forge reference, but the projects dashboard and project settings are sparse. Settings leave the builder, integration forms render as raw inline fields, and the application has no shared navigation shell. The result feels like a set of completed screens instead of one product.

This design applies the supplied references without copying their branding or unsupported provider catalog:

- Lovable-style persistent workspace navigation and project gallery.
- Forge/Emergent-style prompt composer and conversational two-pane builder.
- An in-builder Preview/Manage switch that keeps API-backed project operations beside the conversation.
- zapp.build terminology, safety states, verification evidence, and deployment controls.

## Goals

1. Make sign-in, prompt creation, projects, builder, preview, integrations, billing, and deployment feel like one application.
2. Keep every visible state and mutation backed by the generated public SDK or structured `AgentEvent` data.
3. Preserve the existing route map and direct links while allowing settings and management screens to render inside the builder.
4. Use TypeScript for navigation models, provider metadata, reducers, schemas, API adapters, and view state. Use TSX only for components that render JSX.
5. Match the reference density, hierarchy, spacing, rounded surfaces, soft gradients, compact controls, and split-pane behavior.
6. Preserve accessibility, tenant isolation, role enforcement, secret handling, idempotency, and truthful failure reporting.

## Non-goals

- Adding unsupported integrations from the references. Twilio, PayPal, Razorpay, Resend, SendGrid, and model-provider connection cards do not ship without public contracts and plan approval.
- Replacing Stytch, the generated SDK, Next App Router, or the existing design tokens.
- Building a second client-side data model for settings or run state.
- Removing deep-link settings, release, health, usage, billing, or audit routes.
- Introducing a CSS-in-TypeScript runtime solely to increase the number of `.ts` files.

## Selected direction

Use a hybrid shell:

- Dashboard and project browsing use the Lovable reference as the main layout model.
- Prompt composition and project work use the Forge/Emergent references.
- The builder retains zapp's conversation-first requirements, structured cards, verification, Mission Control, and safe deployment flow.

A visual-only reskin was rejected because it would leave settings disconnected. A full SPA rewrite was rejected because it would replace working routes and API integrations without improving the product contract.

## Information architecture

### Shared application shell

Authenticated pages render inside a shared `AppShell`.

The desktop sidebar is 248 pixels wide and contains:

- zapp.build brand mark and name.
- Organization switcher from `/v1/me` active memberships.
- Dashboard, Projects, and Templates.
- Usage and Billing for account-level operations.
- A recent-project list from the loaded project summary projection.
- Account menu, organization settings, and sign out.

The sidebar becomes a 64-pixel icon rail between 1024 and 1279 pixels. Below 1024 pixels it becomes an accessible drawer. The project builder allows the sidebar to collapse manually at desktop widths.

Do not show Starred, Shared with me, global Search, or unsupported Connectors until their public contracts exist.

### Route behavior

- `/` renders the prompt-first dashboard plus My projects.
- `/projects` renders the full project grid with organization switching, pagination, new project, and GitHub import.
- `/projects/:id` renders the builder.
- Existing project settings, releases, and health routes stay available and render the same extracted components used by in-builder Manage.
- Existing organization usage, billing, audit, and settings routes stay available inside `AppShell`.

## Home and dashboard

The home page uses a full-width sky-to-white gradient in the content area. The heading, product-type tabs, prompt card, attachment controls, voice control, submit control, suggestions, and templates link remain centered.

Below the prompt area, My projects appears in a raised white panel. Project cards show:

- Real preview thumbnail when one exists.
- Designed project placeholder when no thumbnail exists.
- Project name and support level.
- Last activity.
- Preview and Production states with icon plus text.
- Deploy readiness when available.
- Open action.

The complete grid remains at `/projects`; the dashboard shows the most recent subset and a Browse all action.

### Project thumbnail contract

The existing summary projection has no browser-safe thumbnail. Add an optional `previewThumbnail` projection to `GET /v1/projects/summaries`:

```ts
interface ProjectPreviewThumbnail {
  artifactId: string;
  capturedAt: string;
  commitSha: string;
  alt: string;
}
```

The browser reads image bytes through a new tenant-scoped `GET /v1/projects/:projectId/preview-thumbnail/:artifactId` operation using the generated client, then creates a short-lived object URL. The route verifies organization and project ownership, serves only screenshot artifacts already redacted by the preview pipeline, and returns 404 for cross-tenant or stale artifact access. The web client limits concurrent thumbnail loads and revokes object URLs when cards leave the page.

The thumbnail is optional. Absence never triggers screenshot capture, workspace startup, or a mutating request from the dashboard.

## Builder shell

The builder keeps three columns at 1440 pixels and above:

1. Shared application sidebar.
2. Conversation pane, default 40 percent of remaining width with a 380-pixel minimum.
3. Working surface, the remaining width.

The existing persisted resize control remains. Between 1024 and 1439 pixels the app sidebar collapses to the icon rail. Below 1024 pixels the conversation and working surface become mutually selectable full-width panes.

### Project header

The header shows project name, save/run status, Preview environment badge, support level, GitHub sync state, Deploy, Mission Control, and project settings. Compact icon controls replace long text controls when space is limited. Deploy keeps its current readiness and role rules.

### Conversation

Conversation remains the primary control surface. It renders only validated public events and read models:

- User and assistant messages.
- Typed question cards.
- Specification summaries.
- Plan review and approval cards.
- Phase progress.
- Tool activity summaries.
- Commit chips.
- Failure and recovery actions.

The composer stays pinned to the bottom. Attachments, selected preview elements, screenshots, mode, model, branch, budget, Stop, and Send reuse existing public mutations and stable operation keys.

### Working surface

The right pane has two top-level modes:

- `Preview`
- `Manage`

Preview contains sub-tabs:

- Preview
- Files
- Code
- More

More exposes Logs, Tests, Releases, and Health. Direct tabs may remain visible at wider widths when there is room. This is presentation-only; existing components and contracts remain the source.

Manage contains:

- Integrations
- Payments
- Secrets
- Members
- GitHub
- Project settings

Manage state may be represented in the URL query string for reload and shareability, but deep-link routes remain canonical entry points.

## Manage surfaces

### Integrations

Render a searchable card grid from typed provider metadata in a `.ts` catalog. The only P0 provider cards are GitHub, Supabase, Neon, Stripe, and Vercel.

Each card shows provider icon, name, short description, status, connected account metadata, and Connect or Disconnect. Provider credential entry opens a drawer or dialog. Secret values exist only in local controlled inputs until submission, go through the generated client once, clear immediately, and never render from a response.

### Payments

The project Payments screen covers the generated application's Stripe integration. It is distinct from zapp.build account billing. Account Billing stays in the shared sidebar and uses `/v1/billing/*` plus `/v1/usage/summary`.

### Secrets, members, and GitHub

Extract these from the current monolithic `ProjectSettings` component into focused API-backed modules. Route pages and in-builder Manage import the same components. Owners, builders, and viewers see controls based on the existing role matrix. Hiding a button is not authorization; the backend remains authoritative.

## Authentication and session behavior

The login flow remains Stytch B2B through the control API:

1. `/login` presents the branded sign-in screen.
2. Sign in starts the public control-plane authorization flow.
3. `/auth/callback` exchanges provider state through the backend.
4. The control API sets the secure session and CSRF cookies.
5. Authenticated pages load `/v1/me`, resolve active organization membership, and inject `x-organization-id` through the central client.
6. Invalid or expired sessions return to `/login` with a short explanation and retry action.

No Stytch SDK or secret enters the browser beyond the existing public redirect flow.

## State and TypeScript boundaries

Use `.ts` for:

- `shell-navigation.ts`
- `manage-navigation.ts`
- `integration-catalog.ts`
- Project-card view models and formatters.
- Query adapters and request-generation fences.
- Reducers for shell, surface, and Manage selection.
- Zod schemas for any new API projection.
- Thumbnail object-URL lifecycle helpers.

Use `.tsx` for small rendering components. Split components when they combine fetching, mutation, and multiple unrelated sections.

Keep CSS in semantic token files and CSS Modules. No raw hex values in components. Existing `@zapp/ui` primitives remain the base.

## Data flow

```text
Stytch redirect
  -> control API session cookies
  -> GET /v1/me
  -> active organization
  -> generated SDK with x-organization-id

Home prompt
  -> keyed POST /v1/projects
  -> keyed POST /v1/projects/:id/runs
  -> /projects/:id
  -> structured SSE events
  -> conversation + Preview + Mission Control

Manage
  -> generated SDK reads
  -> role-aware controls
  -> keyed public mutations
  -> bounded refresh/reconciliation
```

No component parses assistant prose to infer run, preview, approval, integration, verification, deployment, or billing state.

## Failure handling

Reads show a bounded loading state, a truthful empty state, or a Retry action. They do not claim a mutation occurred.

Mutations:

- Disable duplicate submission while a request is active.
- Reuse the same idempotency key for visible retries of the same intent.
- Fence late responses when organization, project, route, or request generation changes.
- Reconcile from a public read after completion.
- Keep credential fields cleared after any request attempt that could have reached the server.

Builder failures preserve the required actions when backed by distinct contracts: Fix automatically, Inspect details, Retry, and Ask the agent. Unsupported actions do not appear as disabled decoration.

Cross-tenant reads render the same not-found state as missing resources. Secret values never enter logs, events, analytics, URLs, or rendered error detail.

## Responsive behavior

- 1440 pixels and wider: sidebar, conversation, and working surface remain visible.
- 1280 to 1439 pixels: compact sidebar rail; two builder panes remain visible.
- 1024 to 1279 pixels: rail plus constrained builder panes; low-priority header labels collapse to icons.
- Below 1024 pixels: application navigation drawer and a Conversation/Workspace bottom switcher.
- Below 640 pixels: cards become one column; composer and dialogs use the full width; tables switch to labeled rows.

Keyboard focus follows visual order. Opening a drawer or dialog traps focus and returns it to the initiating control. State changes use polite live regions. Color is never the only status signal.

## Testing contract

### Component and reducer tests

- Navigation and role projection.
- Provider catalog filtering.
- Surface selection and URL restoration.
- Thumbnail object-URL cleanup and bounded loading.
- Project-card view models.
- Error and empty-state rendering.

### Playwright flows

1. Branded login through the local auth port, then authenticated shell.
2. Home prompt creates a project and run through the public API and lands in the builder.
3. Dashboard loads real project summaries and optional authenticated thumbnails.
4. Organization switching fences stale project, summary, and thumbnail responses.
5. Builder renders question, specification, plan, progress, preview, and failure events from structured payloads.
6. Preview/Manage selection persists and direct settings links render the same extracted module.
7. Owner connects and disconnects each supported integration through public operations.
8. Viewer sees read-only Manage surfaces and cannot issue mutations.
9. Secret and provider credential values never appear in rendered DOM, responses, logs, or analytics fixtures.
10. Account billing and project Stripe integration remain visibly distinct.
11. Responsive desktop, rail, tablet, and mobile states remain keyboard usable.
12. Connected E1 prompt-to-deployment journey stays green.

Run package lint, typecheck, build, focused Playwright, API-client generation checks, affected control-api tests, and the repository verification command required by the owning task.

## Delivery sequence

1. Add the public thumbnail projection and generated SDK operation test-first.
2. Expand the design system tokens and shared shell primitives.
3. Ship `AppShell` around authenticated routes.
4. Compose prompt home with the recent project gallery.
5. Restyle the full projects dashboard.
6. Refine the builder header, panes, and Preview navigation.
7. Extract settings modules and embed Manage.
8. Restyle authentication, billing, usage, release, and health pages inside the shell.
9. Run focused accessibility and responsive passes.
10. Run the connected E1 journey once at final acceptance, not per review round.

## Acceptance criteria

- The supplied reference interaction model is recognizable on home, projects, builder, and Manage.
- A user can sign in, create a project, answer the agent, preview, manage supported integrations, inspect verification, and deploy without a UI-private API.
- Existing deep links remain valid.
- All mutations use public SDK operations and stable operation keys.
- Unsupported integrations are absent.
- Viewer, builder, and owner behavior matches backend authorization.
- No secret value renders or enters client telemetry.
- Desktop and mobile core flows pass keyboard and axe checks.
- Focused web, control-api, API-client, lint, typecheck, build, and connected E1 verification pass.
