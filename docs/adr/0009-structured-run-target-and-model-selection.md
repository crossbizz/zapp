# ADR-0009: Structured run target and model selection

- Status: Proposed
- Date: 2026-08-05
- Owners: Control plane / agent runtime / web
- Affects: CP-9, AR-1/AR-8, WEB-3/WEB-6, generated public API and SDK
- References: master Global Constraint 11, master API-first directive, Plan 08 WEB-3

## Context

WEB-3 requires a `Web App | Mobile App` selector and a model picker constrained by
the organization's model policy. The locked public run mutation currently accepts
only `mode`, `prompt`, optional `branchId`, and optional `budget`. Its durable
`StartRunInput` has the same omission. Consequently, a client cannot communicate
either selection to the control plane or durable workflow.

The first WEB-3 implementation exposed both controls but discarded their values.
Independent review rejected that behavior: an enabled control that cannot affect
the run is false product state, and sending the values through a private route,
prompt convention, or browser-only state would violate API-first and the rule that
workflow state is structured rather than parsed from prose.

## Proposed decision

Extend the public and durable run-intent contracts with two optional, structured
fields:

- `appType: "web" | "mobile"`, defaulting to `"web"` for existing clients;
- `model: string`, absent when the organization policy should choose automatically.

The control plane validates an explicit model against the selected organization's
model policy before recording the run. It persists both resolved intent values with
the `agent_runs` row before starting Temporal, includes them in run reads, and passes
them through `StartRunInput` to the durable workflow. OpenAPI and `@zapp/api-client`
are regenerated before a UI can enable Mobile App or an explicit model choice.

Until this ADR is accepted and the API/runtime work lands, WEB-3 keeps Mobile App
disabled and exposes only policy-managed automatic model selection. It must not show
an enabled control whose value is ignored.

Rejected alternatives:

- Prefix or append instructions to `prompt`: this makes structured run intent depend
  on parsing prose and mutates the user's first message.
- Keep the selections only in browser or builder state: the already-started durable
  run never receives them, and another client cannot reconstruct the run intent.
- Change organization-wide model settings for one run: that is a global policy
  mutation, not a per-run selection, and can race other users' runs.
- Expose controls now and wire them later: that reports a user choice as applied when
  the platform discarded it.

## Consequences

- The control-plane body schema, OpenAPI document, generated SDK, tenant database
  schema/migration, run read model, orchestrator port, and Temporal input all change
  together.
- Existing clients remain compatible because `appType` defaults to web and omitted
  `model` preserves policy routing.
- Explicit model selection becomes auditable and enforceable at the tenant boundary;
  Mobile App acquires durable semantics instead of being a cosmetic tab.
- WEB-3 remains blocked and unchecked until this ADR is accepted and the public API
  ships, after which its reviewed branch must also repair retry idempotency, tooltip
  accessibility, true textarea autosizing, reactive organization switching, and
  stale-session retry state.
