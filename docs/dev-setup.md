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

## Run the M1 prompt-to-preview platform

The M1 local command starts the Docker dependencies, applies migrations, builds
the required packages, prepares the locked sandbox image, and then
supervises every application process needed by the browser flow. It opens the
web UI after all readiness checks pass:

```bash
pnpm local
```

Use `--no-open` when you want to open the UI yourself:

```bash
pnpm local --no-open
```

The application URLs are:

- web UI: http://127.0.0.1:3000
- control API: http://127.0.0.1:4000
- model gateway: http://127.0.0.1:4100
- sandbox service: http://127.0.0.1:4400
- Git service: http://127.0.0.1:4500

In addition to the generated local platform secrets, M1 requires these real
development/test values in the untracked root `.env`:

```text
STYTCH_PROJECT_ID
STYTCH_SECRET
STYTCH_PUBLIC_TOKEN
ANTHROPIC_API_KEY
```

Configure the Stytch test project to allow
`http://127.0.0.1:4000/v1/auth/callback`.

Local startup defaults to `SANDBOX_PROVIDER=docker`. The sandbox service creates
one isolated workspace container and one private Docker network per active
project branch, with only loopback-bound agent and preview ports. Project cache
data is reused through a project-scoped volume; writable source trees are never
shared across organizations or projects. Docker provides structural process,
filesystem, and full-connectivity isolation locally. It does not claim Modal's
per-domain egress enforcement, and the audit evidence records that distinction.

To exercise the production provider locally, set `SANDBOX_PROVIDER=modal` and
also configure:

```text
MODAL_TOKEN_ID
MODAL_TOKEN_SECRET
```

Those credentials must access the `zapp-dev` environment and the immutable
image names recorded in `infra/modal/images.lock.json`. Startup verifies the
selected provider's locked image and never rebuilds or republishes it.

Press Ctrl-C once to stop the seven supervised application processes in reverse
dependency order. Postgres, Redis, Forgejo, Temporal, MinIO, and LocalStack stay
running with their data intact, so `pnpm local` can be retried without a reset.

### Real M1 acceptance flow

With `pnpm local --no-open` reporting ready in one terminal, run this in a
second terminal:

```bash
pnpm test:m1:live
```

The command opens a persistent Chromium profile. Complete the ordinary Stytch
sign-in when prompted; the runner does not bypass or automate authentication.
It then uses the real UI to submit a unique initial prompt and follow-up edit,
checks the authenticated preview for both markers, records distinct internal
Git commits through the public Mission Control API, terminates the active Modal
workspace through the public workspace API, and submits one more UI request to
prove durable restore into a replacement workspace. Redacted JSON evidence and
screenshots are written under ignored `.artifacts/m1-live/`.

The live command is intentionally fail-closed: it accepts no fixture or session
bypass flags, does not auto-rerun provider work, and exits nonzero at the named
stage when an assertion fails. Fix the reported stage, keep the local platform
running, and invoke the command again deliberately if a new provider run is
appropriate.

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

- **`Local M1 provider configuration is missing`** — add each named variable to
  the root `.env`; values are never printed.
- **`Local application port ... is already in use`** — stop the process using
  that exact application port. Infrastructure port overrides do not change the
  five fixed application ports listed above.
- **`Command failed: docker info`** — start Docker Desktop, OrbStack, or Colima.
- **A named application exits before shutdown** — inspect its prefixed log tail;
  the supervisor stops the remaining application processes and leaves Docker
  data running for a retry.
- **`M1 live gate failed at authenticated session`** — confirm the Stytch test
  callback URL, then complete sign-in in the Chromium window.
- **`M1 live gate failed at initial preview`, `edited preview`, or `restored
  preview`** — the provider-backed run did not produce the required commit,
  healthy preview, visible marker, or replacement workspace before the bounded
  deadline. The failed run is not reported as passed and is not retried
  automatically.

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
