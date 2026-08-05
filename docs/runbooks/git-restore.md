# Git bundle restore

Use this runbook when a provisioned internal Forgejo repository must be rebuilt from its daily R2 bundle. PostgreSQL remains the repository/branch inventory and Forgejo remains the Git source of truth after recovery.

## Preconditions and scope

- Confirm the incident organization and project IDs with the control-plane database owner.
- Confirm the `repositories` row is an internal repository with non-null `provisioned_at` and that the `branches` rows contain the expected heads. Null heads are unborn branches and are not compared.
- Select exactly one object under `org/{organizationId}/project/{projectId}/git-backups/`. Prefer the newest known-good `YYYY-MM-DD.bundle`; record the full key in the incident log.
- Choose a durable, non-secret incident idempotency key and record it with the selected object key. Reusing the same key with the same selector resumes that operation; reusing it with a different selector fails before Forgejo mutation.
- Do not delete or rename a failed restore target. The command may resume only the exact target whose durable target receipt records the expected ref, marker, and immutable Forgejo repository ID. A marker without that ID receipt is insufficient; any missing receipt or mismatch is preserved and refused.
- Inject `DATABASE_URL`, `FORGEJO_URL`, `FORGEJO_ADMIN_TOKEN`, and `ARTIFACT_ENDPOINT/KEY/SECRET/BUCKET/REGION` from the approved secret manager into the process environment. Never place a token in a Git URL, command argument, shell history, workflow value, fixture, or file.

Git bundles do **not** contain Git LFS objects, Forgejo metadata, issues, pull requests, users, or repository settings. Forgejo volume snapshots are the LFS/object backup half. A complete incident restore requires the matching PostgreSQL metadata and Forgejo volume state; the bundle alone is not a full Forgejo backup.

## Restore

Set only the non-secret selectors below. Use the exact IDs and object key recorded during preflight.

```bash
set -euo pipefail
export GIT_RESTORE_ORGANIZATION_ID='org_<26-character-ULID>'
export GIT_RESTORE_PROJECT_ID='proj_<26-character-ULID>'
export GIT_RESTORE_KEY="org/${GIT_RESTORE_ORGANIZATION_ID}/project/${GIT_RESTORE_PROJECT_ID}/git-backups/<YYYY-MM-DD>.bundle"
export GIT_RESTORE_IDEMPOTENCY_KEY='incident-<durable-unique-id>'
restore_evidence="git-restore-${GIT_RESTORE_PROJECT_ID}-$(date -u +%Y%m%dT%H%M%SZ).json"
services/git-service/scripts/restore-evidence.sh "$restore_evidence"
```

The wrapper invokes the real TypeScript CLI directly with pnpm's own output silenced and preserves its exit status. It writes CLI stdout to a same-directory `mktemp` sibling, validates that the temporary file is exactly one JSON document with the selected organization/project IDs, exact result fields, full Git ref names, 40-hex SHAs, the required status/count, and equal expected/actual branch SHAs, fsyncs it, then publishes it atomically with a no-clobber hard link. Producer or validation failure removes the temporary file and leaves no final evidence; a pre-existing evidence path is never overwritten. The JSON contains every compared branch as exact `name`, `expectedSha`, and `actualSha` values, plus every restored ref returned by `git ls-remote --refs` as exact `name` and `sha` values. It never emits the clone URL, access keys, tokens, database URL, or idempotency key.

The command performs the recovery in this order:

1. conditionally persists the selector-bound intent receipt before any Forgejo repository creation;
2. streams the selected object to a controller-created temporary directory, rejects an empty object, and runs `git bundle verify`;
3. resolves the expected target: a confirmed create records its immutable repository ID; an existing repository is accepted only when a prior target receipt matches its ref, marker, and ID. A marker-only repository and a create conflict are refused;
4. grants a restricted ephemeral user access to that repository, re-reads and matches the immutable ID after the collaborator grant, then uses that repository-bound credential for the mirror push and every remote-ref read. A replacement at the same path cannot inherit the grant;
5. records `push-started`, mirror-pushes every ref from the bundle (including tags and non-branch refs), records `push-complete`, compares every non-null expected branch SHA with the `branches` table, emits exact branch/ref evidence, and records `verified`;
6. revokes the ephemeral restore identity and removes only local temporary bundle, mirror, and askpass files.

Any failed download, verification, create, push, or SHA comparison exits non-zero. A missing or mismatched expected branch is never reported as success.

## Non-destructive retry and recovery

The restore process never automatically deletes a Forgejo repository. Forgejo has no atomic delete-by-immutable-ID guard, so a path-based delete could remove a replacement installed after the final ownership check. Safety takes precedence over cleanup: failed and interrupted attempts retain their target and append-only intent, target, and phase receipts.

Retry with the same `GIT_RESTORE_IDEMPOTENCY_KEY` and unchanged selector. The retry resumes the exact ID-receipt-owned target and safely replays mirror push and verification. If creation succeeded but the immutable-ID receipt was not saved, the marker alone does not authorize adoption: the retry exits non-zero and preserves the repository for operator reconciliation. An absent target, changed ID or marker, create conflict, or different selector also exits non-zero without repository deletion. Never remove the organization or R2 source object as part of restore recovery.

The scheduled quarterly drill holds the PostgreSQL advisory lease for the entire operation and normally reuses one deterministic, persistent drill target. Each selected bundle gets its own intent/phase receipts, while the stable target receipt pins the target ref, marker, and immutable repository ID. An explicitly empty backup uses a second deterministic receipt-owned empty target so a prior default branch cannot survive Forgejo's current-branch deletion protection; later empty drills reuse that same target. A crash or mismatch never authorizes deletion, and quarterly drills use at most the persistent and empty target for a source repository.

## Evidence checklist

- Incident ID, operator, timestamp, organization ID, project ID, and selected R2 key.
- `git bundle verify` success from the restore command.
- Intent key, immutable target ID/marker confirmation, and mirror-push success.
- Count of non-null database branches checked.
- Saved JSON plus the tab-separated exact expected/actual SHA output for each checked branch.
- Saved complete `git ls-remote --refs` name/SHA output, including tags and non-branch refs.
- Matching PostgreSQL and Forgejo volume/LFS snapshot identifiers.
- Retry/receipt status for a failed attempt, or restored repository URL for a successful attempt.
- Final command exit status; never relabel a non-zero result as restored.
