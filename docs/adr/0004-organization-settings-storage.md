# ADR-0004: Organization settings storage

- Status: Proposed — human approval required
- Date: 2026-08-04
- Owners: Control plane / data model

## Context

Plan 02 CP-12 requires `GET/PATCH /v1/organizations/:orgId/settings` to persist
`builderCanDeploy` and a `defaultModelPolicy` JSON document. CP-11 must read the
same persisted `builderCanDeploy` value when evaluating the configurable Builder
deploy permission.

The locked PRD §23.1 `organizations` model has no settings or configuration
column, and no organization-settings table exists. The Drizzle schema follows
that model exactly. `packages/db/test/prd-schema-conformance.test.ts` rejects
unrecorded extra tables and columns, so implementing CP-12 without a data-model
decision would either make the API process-local or misuse an unrelated table.
Neither is durable or tenant-safe.

## Proposed decision

Add an `organizations.settings_json` non-null JSONB column with a database default
of `{}`. Record it as an intentional implementation column in the schema
conformance allowlist, with this ADR as the reason.

At the API boundary, parse the document through a strict Zod schema:

- `builderCanDeploy`: boolean, default `false` when absent;
- `defaultModelPolicy`: arbitrary JSON value, passed through without the control
  plane inventing a model-provider schema.

PATCH performs a partial merge of only those two top-level keys in the same
transaction as its audit event. Reads return the normalized defaults. The
control plane's deploy permission resolver reads this same store, so the setting
has one source of truth and remains fail-closed for existing rows.

## Consequences

- CP-12 must expand its file contract to include the identity schema, one
  additive migration, schema/store tests, the organization store and its
  in-memory double, app composition, and the new route tests.
- Existing organizations require no backfill because the database default and
  read normalization both yield `builderCanDeploy=false`.
- `defaultModelPolicy` remains opaque JSON until the model-gateway plan owns and
  versions that contract.
- The PRD text remains unchanged; the conformance test carries the documented
  physical-schema exception, as it already does for other implementation
  columns.

## Rejected alternatives

- Process-local or Redis-only settings: not durable organization state and can
  disagree across control-plane replicas.
- Reusing `integration_connections.configuration_json`: wrong ownership and
  would make authorization depend on an unrelated provider record.
- A new `organization_settings` table: valid, but adds an extra table and join
  for two organization-owned values without improving isolation or lifecycle.

