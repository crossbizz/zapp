# Local dev setup

Everything zapp needs locally runs in one docker-compose stack: Postgres, Redis,
Forgejo (internal Git), Temporal, MinIO (artifacts), and LocalStack (SQS/SNS/SES).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node | 22.x | `.nvmrc` pins it — `nvm use` |
| pnpm | 9.15+ | `corepack enable && corepack prepare pnpm@9.15.0 --activate` |
| Docker | with Compose v2 | Docker Desktop, OrbStack, or Colima; the daemon must be running |
| Temporal CLI | optional | only for the lightweight alternative below |

## One-command bootstrap

```bash
pnpm install
./scripts/dev-up.sh
```

`scripts/dev-up.sh` is idempotent — run it as often as you like. It:

1. copies `.env.example` to `.env` if you don't have one yet;
2. starts `infra/docker/docker-compose.dev.yml` and waits for every healthcheck;
3. creates the MinIO bucket `zapp-artifacts`;
4. verifies the six LocalStack queues exist;
5. runs `pnpm db:migrate` (skipped until `packages/db` exists);
6. creates the Forgejo admin user + API token on first run and writes them to
   `.env.local.forgejo` (gitignored — copy `FORGEJO_ADMIN_TOKEN` into `.env`).

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
docker compose -p zapp-dev -f infra/docker/docker-compose.dev.yml exec minio mc ls zapp-local/zapp-artifacts
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

## Troubleshooting

- **`the Docker daemon is not running`** — start Docker Desktop/OrbStack first.
- **A service never turns healthy** — `... logs <service>` shows why; Temporal
  can take ~30s on first boot while it creates its schema.
- **Forgejo changes in `app.ini` don't apply** — `app.ini` is only *seeded* into
  the container's data volume on first boot (Forgejo owns its copy afterwards
  because it writes generated secrets there). Re-run with `down -v` to re-seed.
- **Stale MinIO/LocalStack state** — `down -v` clears all volumes; the
  LocalStack init script re-creates queues on every start anyway.
