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
pnpm --filter @zapp/git-service backup:restore
```

The command performs the recovery in this order:

1. streams the selected object to a controller-created temporary directory;
2. rejects an empty object and runs `git bundle verify`;
3. creates the exact fresh, empty Forgejo repository;
4. mirror-pushes every ref from the bundle, including tags and non-branch refs;
5. reads remote branch heads and compares every non-null expected SHA with the `branches` table;
6. removes all temporary bundle, mirror, and askpass files.

Any failed download, verification, create, push, or SHA comparison exits non-zero. A missing or mismatched expected branch is never reported as success.

## Rollback and cleanup

If restore fails after the fresh repository was created, preserve its logs/evidence first, then remove only that exact restore target:

```sh
pnpm --filter @zapp/git-service backup:restore-cleanup
```

Do not remove the organization: it can own other projects. Do not delete the R2 source object during rollback. Re-run the restore only after confirming the target repository is absent and the same object key is still selected.

The scheduled quarterly drill uses a random organization/project pair, verifies the same database heads, then deletes only its disposable repository and newly created empty organization in a `finally` path.

## Evidence checklist

- Incident ID, operator, timestamp, organization ID, project ID, and selected R2 key.
- `git bundle verify` success from the restore command.
- Fresh-target confirmation and mirror-push success.
- Count of non-null database branches checked.
- Exact expected and actual SHA for each checked branch.
- Tag/ref comparison or clone evidence appropriate to the incident.
- Matching PostgreSQL and Forgejo volume/LFS snapshot identifiers.
- Cleanup result for a failed attempt, or restored repository URL for a successful attempt.
- Final command exit status; never relabel a non-zero result as restored.
