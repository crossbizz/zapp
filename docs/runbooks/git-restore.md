# Git bundle restore

Use this runbook when a provisioned internal Forgejo repository must be rebuilt from its daily R2 bundle. PostgreSQL remains the repository/branch inventory and Forgejo remains the Git source of truth after recovery.

## Preconditions and scope

- Confirm the incident organization and project IDs with the control-plane database owner.
- Confirm the `repositories` row is an internal repository with non-null `provisioned_at` and that the `branches` rows contain the expected heads. Null heads are unborn branches and are not compared.
- Select exactly one object under `org/{organizationId}/project/{projectId}/git-backups/`. Prefer the newest known-good `YYYY-MM-DD.bundle`; record the full key in the incident log.
- Ensure no repository exists at the target Forgejo ref. The restore command refuses a non-empty target; it never overwrites an existing repository.
- Inject `DATABASE_URL`, `FORGEJO_URL`, `FORGEJO_ADMIN_TOKEN`, and `ARTIFACT_ENDPOINT/KEY/SECRET/BUCKET/REGION` from the approved secret manager into the process environment. Never place a token in a Git URL, command argument, shell history, workflow value, fixture, or file.

Git bundles do **not** contain Git LFS objects, Forgejo metadata, issues, pull requests, users, or repository settings. Forgejo volume snapshots are the LFS/object backup half. A complete incident restore requires the matching PostgreSQL metadata and Forgejo volume state; the bundle alone is not a full Forgejo backup.

## Restore

Set only the non-secret selectors below. Use the exact IDs and object key recorded during preflight.

```sh
export GIT_RESTORE_ORGANIZATION_ID='org_<26-character-ULID>'
export GIT_RESTORE_PROJECT_ID='proj_<26-character-ULID>'
export GIT_RESTORE_KEY="org/${GIT_RESTORE_ORGANIZATION_ID}/project/${GIT_RESTORE_PROJECT_ID}/git-backups/<YYYY-MM-DD>.bundle"
restore_evidence="git-restore-${GIT_RESTORE_PROJECT_ID}-$(date -u +%Y%m%dT%H%M%SZ).json"
set -o pipefail
pnpm --filter @zapp/git-service backup:restore | tee "$restore_evidence"
jq -e '.status == "restored" and .checkedBranches == (.branches | length)' "$restore_evidence"
jq -r '.branches[] | [.name, .expectedSha, .actualSha] | @tsv' "$restore_evidence"
jq -r '.refs[] | [.name, .sha] | @tsv' "$restore_evidence"
```

The command emits one JSON object containing every compared branch as exact `name`, `expectedSha`, and `actualSha` values, plus every restored ref returned by `git ls-remote --refs` as exact `name` and `sha` values. It never emits the clone URL, access keys, tokens, or database URL. The `jq` commands both validate the branch count and produce executable tab-separated branch/ref evidence for the incident record.

The command performs the recovery in this order:

1. streams the selected object to a controller-created temporary directory;
2. rejects an empty object and runs `git bundle verify`;
3. creates the exact fresh, empty Forgejo repository;
4. mirror-pushes every ref from the bundle, including tags and non-branch refs;
5. reads every actual remote ref, compares every non-null expected branch SHA with the `branches` table, and emits exact branch/ref evidence;
6. removes all temporary bundle, mirror, and askpass files.

Any failed download, verification, create, push, or SHA comparison exits non-zero. A missing or mismatched expected branch is never reported as success.

## Automatic compensation

The restore process receives a no-argument compensation closure only after it has created and verified the exact fresh target. A failure during mirror push or verification invokes that closure before the command exits non-zero. A failure before target creation deletes nothing. There is deliberately no standalone repository-deletion command or selector.

If automatic compensation itself fails, preserve the command output and escalate for operator review. Do not delete another repository, remove the organization, or delete the R2 source object. Re-run the restore only after confirming the exact failed target is absent and the same object key is still selected.

The scheduled quarterly drill uses a random organization/project pair, verifies the same database heads, then deletes only its disposable repository and newly created empty organization in a `finally` path.

## Evidence checklist

- Incident ID, operator, timestamp, organization ID, project ID, and selected R2 key.
- `git bundle verify` success from the restore command.
- Fresh-target confirmation and mirror-push success.
- Count of non-null database branches checked.
- Saved JSON plus the tab-separated exact expected/actual SHA output for each checked branch.
- Saved complete `git ls-remote --refs` name/SHA output, including tags and non-branch refs.
- Matching PostgreSQL and Forgejo volume/LFS snapshot identifiers.
- Cleanup result for a failed attempt, or restored repository URL for a successful attempt.
- Final command exit status; never relabel a non-zero result as restored.
