# Local dev setup

Everything zapp needs locally runs in one docker-compose stack: Postgres, Redis,
Forgejo (internal Git), Temporal, MinIO (artifacts), and LocalStack (SQS/SNS/SES).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | 22.x | `.nvmrc` pins it — `nvm use` |
| pnpm | 9.15+ | `corepack enable && corepack prepare pnpm@9.15.0 --activate` |
| Docker | with Compose v2 | Docker Desktop, OrbStack, or Colima; the daemon must be running |
| curl | any | used by `dev-up.sh` for health and token checks (preinstalled on macOS/Linux) |
| Temporal CLI | optional | only for the lightweight alternative below |

## One-command bootstrap

```bash
pnpm install
./scripts/dev-up.sh
```

`scripts/dev-up.sh` is idempotent — run it as often as you like. It:

1. copies `.env.example` to `.env` if you don't have one yet, then fills the
   platform secrets (`SESSION_JWT_SECRET`, `SERVICE_TOKEN_SECRET`,
   `RUN_INTENT_HMAC_SECRET`, `SECRETS_MASTER_KEY`) with generated local values wherever they are still
   `replace-me` — in an `.env` you already had as well as a new one, which is how
   an older copy gets healed. A value you set yourself is never overwritten, and
   variables the template has gained since your `.env` was copied are named in a
   warning rather than filled in;
2. starts `infra/docker/docker-compose.dev.yml` and waits for every healthcheck;
3. creates the MinIO bucket `zapp-artifacts`;
4. verifies the six LocalStack queues exist;
5. runs `pnpm db:migrate` (skipped until `packages/db` exists);
6. creates the Forgejo admin user + API token and writes them to
   `.env.local.forgejo` (gitignored — copy `FORGEJO_ADMIN_TOKEN` into `.env`).
   On later runs it reuses the stored token, and if that token no longer works
   (e.g. after `down -v`) it mints a fresh one while keeping the admin password
   in the file valid.

## Services

| Service | URL / address | Credentials |
| --- | --- | --- |
| Postgres 16 | `postgres://zapp:zapp@localhost:5432/zapp` | `zapp` / `zapp` |
| Redis 7 | `redis://localhost:6379` | none |
| Forgejo 9 | http://localhost:3300 (SSH `localhost:2222`) | see `.env.local.forgejo` |
| Temporal | `localhost:7233` (namespace `default`) | none |
| Temporal UI | http://localhost:8233 | none |
| MinIO S3 API | http://localhost:9000 | `minioadmin` / `minioadmin` |
| MinIO console | http://localhost:9001 | `minioadmin` / `minioadmin` |
| LocalStack | http://localhost:4566 | `test` / `test` |

All ports bind to `127.0.0.1` only, so the stack is never exposed on your network.

### What the stack pre-creates

- MinIO bucket `zapp-artifacts` (`ARTIFACT_BUCKET`).
- SQS queues `zapp-usage-events`, `zapp-github-webhooks`, `zapp-notifications`,
  each paired with a `-dlq` queue and a redrive policy of `maxReceiveCount=5`.
- SES verified sender `dev@zapp.local`.
- Temporal namespace `default` with a 24h retention, using its own
  `temporal` / `temporal_visibility` databases on the same Postgres instance.
- Forgejo configured from `infra/docker/forgejo/app.ini`: registrations disabled,
  admin API + basic auth enabled, webhook targets allowlisted for
  `host.docker.internal` and `localhost` so services on your host receive hooks.

## Everyday commands

```bash
# stop the stack (keeps data)
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml down

# wipe everything and start fresh
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml down -v
./scripts/dev-up.sh

# logs / status
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml logs -f temporal
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml ps

# psql, redis-cli, awslocal, mc without installing anything
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml exec postgres psql -U zapp -d zapp
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml exec redis redis-cli
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml exec localstack awslocal sqs list-queues
# the image's built-in `local` alias has no credentials, so set one up first
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml exec minio \
  sh -c 'mc alias set zapp-local http://127.0.0.1:9000 minioadmin minioadmin >/dev/null && mc ls zapp-local/zapp-artifacts'
```

## Port conflicts

If a port is already taken, override it for the compose stack and re-run — the
script prints the same override hint when startup fails:

```bash
ZAPP_LOCALSTACK_PORT=4567 ./scripts/dev-up.sh
```

Available overrides (defaults in parentheses): `ZAPP_POSTGRES_PORT` (5432),
`ZAPP_REDIS_PORT` (6379), `ZAPP_FORGEJO_HTTP_PORT` (3300),
`ZAPP_FORGEJO_SSH_PORT` (2222), `ZAPP_TEMPORAL_PORT` (7233),
`ZAPP_TEMPORAL_UI_PORT` (8233), `ZAPP_MINIO_PORT` (9000),
`ZAPP_MINIO_CONSOLE_PORT` (9001), `ZAPP_LOCALSTACK_PORT` (4566).
Update the matching URLs in `.env` when you override a port.

## Temporal without the container

The compose stack runs `temporalio/auto-setup` so `dev-up.sh` stays a single
command. If you prefer the Temporal CLI's dev server (faster start, in-memory
state, same ports), stop the two containers and run it yourself:

```bash
brew install temporal
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml stop temporal temporal-ui
temporal server start-dev --ip 0.0.0.0 --port 7233 --ui-port 8233
```

`TEMPORAL_ADDRESS=localhost:7233` works with either option. State is not shared
between them.

## Environment variables

`.env.example` is the catalogue of every variable the services read, with
placeholder values only. Copy it to `.env` and fill in real keys as each
milestone needs them (see `AGENTS.md` §10). `.env`, `.env.local.forgejo`, and
anything else matching `.env.*` are gitignored — never commit real credentials.

Four variables are generated rather than obtained from a vendor:
`SESSION_JWT_SECRET`, `SERVICE_TOKEN_SECRET`, and `RUN_INTENT_HMAC_SECRET` are
`openssl rand -hex 32`, and
the secrets-vault master key `SECRETS_MASTER_KEY` is `openssl rand -base64 32` —
base64 of exactly 32 bytes, the one value in the file that is not hex. The
control plane refuses to start on anything else, and it has no default: a vault
that invented a key would encrypt secrets nothing else could read, and one that
shared a committed default would encrypt them so that everybody could.
`dev-up.sh` generates all four, so do this by hand only if you are not using it.

`RUN_INTENT_HMAC_SECRET` is a durable data-compatibility key, not a freely
rotatable session secret. Every control-api replica in an environment must use
the same value, and that value must remain stable for as long as an existing
`agent_runs` row may be retried. Changing it makes the same request fingerprint
differ and correctly returns `idempotency_conflict`. Production rotation
therefore requires a dual-key/versioned fingerprint migration or deliberate
cleanup of all rows whose create requests can no longer be retried; simply
replacing the variable in a rolling deploy is unsupported.

`SECRETS_MASTER_KEY_VERSION` (defaults to 1) and `SECRETS_PREVIOUS_MASTER_KEY`
(empty) are the master-key rotation pair — leave both as shipped locally. They
exist so that rotating in staging/prod is a value change rather than a schema
change; `.env.example` documents how a rotation uses them. Do not regenerate
`SECRETS_MASTER_KEY` once you have stored secrets under it: their data keys are
wrapped with it, so a new key leaves the rows undecryptable. Locally the clean
way out is `down -v` and a fresh `.env`.

## Troubleshooting

- **`the Docker daemon is not running`** — start Docker Desktop/OrbStack first.
- **`pnpm dev` exits naming an environment variable** — `Invalid environment:
  SESSION_JWT_SECRET`, or `SECRETS_MASTER_KEY must be base64 of exactly 32 bytes`.
  Your `.env` predates that variable or still holds its `replace-me` placeholder;
  copying `.env.example` happens once, so `.env` does not follow the template when
  it gains one. Re-run `./scripts/dev-up.sh` — it generates the missing local
  secrets in place and names anything else the template has added.
- **A service never turns healthy** — `... logs <service>` shows why; Temporal
  can take ~30s on first boot while it creates its schema.
- **Forgejo changes in `app.ini` don't apply** — `app.ini` is only *seeded* into
  the container's data volume on first boot (Forgejo owns its copy afterwards
  because it writes generated secrets there). Re-run with `down -v` to re-seed.
- **Stale MinIO/LocalStack state** — `down -v` clears all volumes; the
  LocalStack init script re-creates queues on every start anyway.
