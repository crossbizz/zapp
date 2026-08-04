# infra/terraform

Deployed infrastructure for zapp.build. Today: the internal Git service (GIT-1).

## Dev is compose. Production is terraform. They are not the same mechanism, on purpose.

| | dev | staging / production |
| --- | --- | --- |
| Forgejo runs as | a container in `infra/docker/docker-compose.dev.yml` (FND-7) | a Fly.io machine |
| Config seed | `infra/docker/forgejo/app.ini` | `infra/docker/forgejo/app.ini.prod` |
| Storage | a compose volume | a Fly volume, snapshotted |
| Database | SQLite on the volume | managed PostgreSQL |
| Admin token | minted by `scripts/dev-up.sh` into `.env.local.forgejo` | minted by `services/git-service/scripts/bootstrap.ts`, stored as a Fly secret |
| Created by | `./scripts/dev-up.sh` | `terraform apply` then `fly deploy` then `bootstrap` |

The **seeding contract is identical** in both — a committed `app.ini` copied into
the data volume on first boot only, never overwritten, with Forgejo owning its
copy afterwards. That is deliberate: dev and production differ in the contents of
a config file and in nothing about how the instance is assembled, so a setting
that works locally means something in production.

Nothing here touches the dev stack. `terraform apply` cannot affect a laptop, and
`./scripts/dev-up.sh` cannot affect a deployment.

## What terraform owns, and what it does not

**Owns:** the Fly app, the volume, the IPv4 and IPv6 addresses, the TLS
certificate. The objects that outlive every release, and whose accidental
replacement cannot be undone.

**Does not own:** the machine. `fly deploy` and `infra/fly/forgejo/fly.toml` own
the release. A machine in terraform state makes every image bump a state change,
and the community provider — Fly publishes no official one — then proposes to
recreate the machine when it drifts. For a single-volume app that is a detached
volume and a Git host that is down.

**Does not own:** any secret. `FLY_API_TOKEN` comes from the environment, the
database password and the Forgejo admin token are `fly secrets`, and neither
appears in an output. A secret in state is a secret in every backup of state.

## Applying

```sh
cd infra/terraform
terraform init -backend-config=env/staging.backend.hcl   # backend is not committed
terraform plan  -var environment=staging -var fly_org=zapp -var git_domain=git-staging.zapp.build
terraform apply -var environment=staging -var fly_org=zapp -var git_domain=git-staging.zapp.build
```

Then, in order:

```sh
fly secrets set --app zapp-forgejo-staging \
  FORGEJO__database__HOST=… FORGEJO__database__NAME=… \
  FORGEJO__database__USER=… FORGEJO__database__PASSWD=… \
  FORGEJO__server__DOMAIN=git-staging.zapp.build \
  FORGEJO__server__ROOT_URL=https://git-staging.zapp.build/ \
  FORGEJO__server__SSH_DOMAIN=git-staging.zapp.build \
  FORGEJO__webhook__ALLOWED_HOST_LIST=zapp-control-api-staging.internal \
  FORGEJO__metrics__TOKEN="$(openssl rand -hex 32)"

fly deploy --config infra/fly/forgejo/fly.toml \
           --dockerfile infra/fly/forgejo/Dockerfile \
           --app zapp-forgejo-staging .

FORGEJO_URL=https://git-staging.zapp.build FORGEJO_ADMIN_TOKEN=… \
  pnpm --filter @zapp/git-service bootstrap
```

`bootstrap` is idempotent: a second run changes nothing and says so.

**`FORGEJO__metrics__TOKEN` is not optional.** `app.ini.prod` sets
`[metrics] ENABLED = true`, and with an empty token Forgejo serves `/metrics`
to *anyone* — which, on an app that terraform gives a public IPv4, a public IPv6
and a TLS certificate, means the internet. It leaks repository counts, user
counts and instance internals. Set it in the same command as the rest, or turn
metrics off.

## Backups

PRD §19.1 requires backup and restore. Two halves, and only one of them is code:

- **Git objects and LFS** live on the volume. Fly takes daily snapshots; set the
  retention explicitly, because the default is short:

  ```sh
  fly volumes update <volume_id> --snapshot-retention 14 --app zapp-forgejo-staging
  ```

  Deliberately not a terraform variable — `fly_volume` has no attribute for it,
  and a declared-but-unused variable reads like an enforced policy while
  enforcing nothing. `terraform output forgejo_volume_id` gives the id.

- **Repository metadata** (users, organizations, collaborators, tokens, branch
  protection) lives in managed PostgreSQL and inherits that database's backup and
  PITR policy.

A restore needs both, from the same point in time. A volume restored alone has
repositories the database has never heard of; a database restored alone has rows
pointing at objects that are not on disk.

## The token sweep — in the service, not in this runbook

GIT-3's repository-scoped tokens expire because something deletes them, not
because Forgejo knows how to. **The git service does that itself**, every
`TOKEN_SWEEP_INTERVAL_MS` (default 60s), from `src/sweep.ts` — nothing here has to
be scheduled.

That is a correction rather than a convenience. The first cut of GIT-3 left the
schedule to this file, which made a security bound depend on somebody reading a
README; since terraform gives this app a public IPv4, a public IPv6 and a TLS
certificate, an unswept token is reachable from anywhere on the internet until
someone does (GIT review). The sweep is idempotent and cheap, so every replica
running it is redundancy rather than contention.

`POST /internal/git/tokens/sweep` (service token, audience `git-service`) stays
for an operator who wants to force one immediately — during an incident, or after
raising a suspicion about a leaked credential.

## `prevent_destroy` on the volume

`fly_volume` forces replacement on several attribute changes — including `size`,
which the provider cannot extend in place — and a replaced volume is an *empty*
volume. Every repository, gone, from a plan that read like a resize. The lifecycle
block refuses it, and `size` is additionally ignored so that growing the volume
with `fly volumes extend` does not show up as drift.

Removing that block is a deliberate act. It belongs in the same change as a
restore plan, not in a hurry.

## Verification status

`terraform validate` has **not** been run against this configuration: terraform
is not installed on the machine these files were authored on, and `validate`
requires `terraform init` to download the provider first. The configuration is
therefore syntax-reviewed but unverified. Run

```sh
terraform init -backend=false && terraform validate
```

before the first apply, and treat any diagnostic as this file's bug.
