# ADR-0031: Enforce artifact-class retention in the control plane

**Status:** Accepted (controller approval, 2026-08-12)

## Context

Master plan §5.2 locks object keys to
`org/{orgId}/project/{projectId}/{class}/...`, with additional run/test segments
where required by a producer. OPS-14 asks Terraform-managed Cloudflare R2
lifecycle rules to expire test artifacts after 30 days and diagnostics after 7
days while retaining release evidence.

Cloudflare R2 lifecycle conditions match only a prefix from the beginning of an
object key. They do not support wildcards, tags, or a match on a later path
segment. A rule for `test/` or `diagnostic/` would match no conforming object; a
rule for `org/` would delete all classes, including release evidence. Generating
one rule per tenant/project would be incomplete and would couple dynamic product
data to infrastructure state.

## Decision

Keep the locked tenant-first object layout. CP-17's nightly control-plane job is
the authoritative artifact TTL control: it selects structurally classified
artifact rows, deletes the exact R2 object, and only then removes the database
row. Release-evidence rows are excluded by schema, not by a string heuristic.

Terraform owns the bucket's lifecycle document but configures only safe hygiene
that is expressible by prefix (aborting incomplete multipart uploads). It does
not install a broad object-deletion transition. OPS-14's monthly event archives
are immutable and are likewise outside artifact TTL deletion.

This is an approved provider-capability deviation from the literal “artifact
TTLs by class via R2 lifecycle rules” sentence in OPS-14. The retention durations
and user-visible behavior are unchanged.

## Consequences

- No lifecycle rule can accidentally delete release evidence.
- Artifact expiry depends on the monitored CP-17 job rather than R2's background
  lifecycle engine; the CP-17 integration test must prove object and row absence.
- Changing the object layout to class-first, or Cloudflare adding a structural
  tag/class condition, would permit moving deletion back into Terraform in a
  later ADR.
- R2 lifecycle configuration remains versioned and drift-detectable without
  claiming a rule that cannot match production keys.
