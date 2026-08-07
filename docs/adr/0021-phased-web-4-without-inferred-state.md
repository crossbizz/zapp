# ADR-0021: Deliver WEB-4 in truthful API-backed phases

- Status: Accepted
- Date: 2026-08-07
- Owners: web / control plane / integrations
- Approval: controller decision under the user's delegated decision authority, 2026-08-07
- Affects: Plan 08 WEB-4, `apps/web`, Plan 02 public project and membership APIs, Plan 06 INT-1/INT-2
- References: product-owner API-first directive, 2026-08-03; master Global Constraint 20 (image tags, SDK versions, and pricing assumptions live in configuration); Plan 02 CP-2/CP-3/CP-6/CP-16; Plan 08 WEB-3/WEB-4; ADR-0018

## Context

WEB-4 combined three independently backed dashboard capabilities:

1. a projects index, organization switcher, new-project entry, and pagination;
2. project summary state: last activity, preview/production status, and deploy readiness;
3. GitHub installation, repository selection, import, and progress.

The first WEB-4 blocker was WEB-3's new-project flow. WEB-3 is now complete, and the
public generated SDK has enough durable data for a truthful base dashboard:

- `GET /v1/me` returns the signed-in user's memberships, including membership status,
  organization identity, role, and allowed model policy;
- `GET /v1/projects` is tenant-scoped by `x-organization-id` and returns a keyset page
  with `items` and an opaque `nextCursor`;
- each project item includes its durable name and earned support level; and
- WEB-3's prompt composer already creates a project and first run through the public SDK.

The other slices remain unavailable. The project list does not expose last activity,
preview or production status, or deploy readiness. Treating `createdAt` as activity,
deriving environment state from project fields, or manufacturing readiness in the browser
would be inferred state, not a read model. INT-1/INT-2 have not supplied the GitHub
installation repository-picker and import-progress APIs. Test fixtures can validate a
public contract; they cannot substitute for a missing production contract.

Waiting for every field would unnecessarily withhold a useful API-backed dashboard.
Shipping the original design with fixture-only or inferred values would violate API first
and make the UI claim state the platform does not know. The remaining option is phased
delivery with a deliberately narrower first surface.

## Decision

**WEB-4 is delivered in three slices, and the task remains incomplete until all three
binding slices ship.** The tracker and task checkbox stay unchecked after the base slice.

### Slice A — base dashboard, authorized now

The web app may ship:

- `/projects` backed only by the generated SDK;
- an organization switcher populated only from active memberships returned by
  `GET /v1/me`, using the existing per-user selected-organization persistence;
- an infinite project grid backed by keyset-paginated `GET /v1/projects` requests;
- cards containing only project name, `SupportLevelBadge`, and an **Open** link;
- a truthful empty state; and
- **New project** opening a dialog that reuses WEB-3's prompt composer and public
  create-project/create-run flow for the selected organization.

Changing organization clears the accumulated page and cursor before loading that
organization's first page. Only active memberships are selectable. The list request
carries `x-organization-id`; organization membership and tenant scoping remain server
authoritative. Every initial-page and pagination request is abortable and bound to a
monotonic selection generation, so an Alpha response that completes after
Alpha→Beta→Alpha cannot become current merely because its organization id matches again.
Switching also removes any `organizationId` URL override with Next router replacement
semantics while preserving unrelated query parameters; refresh then resolves the persisted
choice instead of a stale override. Initial and switch loading are announced as polite
status updates.

The generic Plan 08 four-action failure pattern applies only when each action has a real,
distinct implementation. For this base read, the public contracts support **Retry** only:
there is no automatic-fix operation, safe detail payload, or conversation/agent endpoint.
The failure UI therefore exposes Retry and nothing else. It must not present a mail link as
"Ask the agent," make Retry masquerade as "Fix automatically," or invent inspection text.
The shared `ErrorState` remains the standard for later failures that can truthfully supply
all four actions; this read uses a retry-only alert until those public capabilities exist.

The base slice must not render last activity, status dots, preview or production state,
readiness, deploy actions, GitHub import controls, repository pickers, or import progress.
It must not infer any of those from `createdAt`, source type, repository presence, or other
available fields.

### Slice B — project summary state, blocked

Last activity, preview/production status, deploy readiness, and a deploy quick action ship
only after a versioned `/v1` read model and generated SDK types expose those values. The
browser renders the returned state; it does not reconstruct it from timestamps, events, or
related resources.

### Slice C — GitHub import, blocked

The GitHub entry, installation flow, repository picker, and import progress ship only with
the INT-1/INT-2 public APIs and generated SDK operations. ADR-0018 still governs the
relationship: Forgejo is the internal project repository and GitHub is an optional peer
remote/import source.

Rejected alternatives:

- **Keep all of WEB-4 blocked.** Truthful, but needlessly couples the available project
  index and WEB-3 creation flow to unrelated summary and GitHub contracts.
- **Render placeholders or fixture-shaped summary state.** A placeholder dot or
  browser-derived readiness still communicates platform state without an authoritative
  API and creates a UI-private contract.
- **Infer activity from `createdAt` and readiness from existing project fields.** Those
  are different facts. The approximation would become stale as soon as runs, previews,
  releases, or deployments change independently.

## Consequences

**Useful now.** Users can switch among organizations, browse every project page by opaque
cursor, open a project, create a new one, and understand the current support tier without
waiting for integration work.

**Deliberately sparse.** Project cards contain less information and fewer actions than the
final WEB-4 design. The absence is intentional and truthful, not a loading or unknown
state.

**Race-safe and history-safe.** Request generation, abort signals, and router replacement
are part of the base contract. Organization identity by itself is insufficient stale-work
gating because a user can return to the same organization before its old request settles.

**Completion remains strict.** Slice A can be tested and staged independently, but WEB-4
cannot be marked done, logged as done, committed under its prescribed completion message,
or checked in `tasks/todo.md` until slices B and C satisfy their acceptance criteria.

**Exit conditions.** Revisit Slice B when the control plane publishes its project-summary
read model. Revisit Slice C when INT-1/INT-2 publish and generate the GitHub operations.
Adding either slice requires TDD against those public SDK contracts; this ADR does not
authorize a browser-private endpoint or inferred substitute.
