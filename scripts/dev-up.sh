#!/usr/bin/env bash
# zapp.build — one-command local dev bootstrap (FND-7).
#
#   ./scripts/dev-up.sh
#
# Brings up infra/docker/docker-compose.dev.yml, waits for every healthcheck,
# then bootstraps the things the stack cannot create by itself: the .env file,
# database migrations, the Forgejo admin token, the MinIO artifact bucket, and
# a check that the LocalStack queues exist.
#
# Safe to re-run: every step is idempotent and no-ops when already done.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker/docker-compose.dev.yml"
PROJECT_NAME="zapp-dev"
FORGEJO_ENV_FILE="$REPO_ROOT/.env.local.forgejo"

# Host ports — keep in sync with docker-compose.dev.yml defaults.
POSTGRES_PORT="${ZAPP_POSTGRES_PORT:-5432}"
REDIS_PORT="${ZAPP_REDIS_PORT:-6379}"
FORGEJO_HTTP_PORT="${ZAPP_FORGEJO_HTTP_PORT:-3300}"
FORGEJO_SSH_PORT="${ZAPP_FORGEJO_SSH_PORT:-2222}"
TEMPORAL_PORT="${ZAPP_TEMPORAL_PORT:-7233}"
TEMPORAL_UI_PORT="${ZAPP_TEMPORAL_UI_PORT:-8233}"
MINIO_PORT="${ZAPP_MINIO_PORT:-9000}"
MINIO_CONSOLE_PORT="${ZAPP_MINIO_CONSOLE_PORT:-9001}"
LOCALSTACK_PORT="${ZAPP_LOCALSTACK_PORT:-4566}"

# Local-only values, matching docker-compose.dev.yml.
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-zapp-artifacts}"
FORGEJO_ADMIN_USER="${FORGEJO_ADMIN_USER:-zapp-admin}"
FORGEJO_ADMIN_EMAIL="${FORGEJO_ADMIN_EMAIL:-admin@zapp.local}"

EXPECTED_QUEUES="zapp-usage-events zapp-usage-events-dlq
zapp-github-webhooks zapp-github-webhooks-dlq
zapp-notifications zapp-notifications-dlq"

WAIT_TIMEOUT="${ZAPP_WAIT_TIMEOUT:-300}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

random_hex() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  "") ;;
  *) die "unknown argument: $1 (try --help)" ;;
esac

# ---------------------------------------------------------------- preflight --
command -v docker >/dev/null 2>&1 || die "docker is not installed — see docs/dev-setup.md"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop/OrbStack and retry"
[ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"

if [ ! -f "$REPO_ROOT/.env" ]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  log "created .env from .env.example (fill in real keys as you need them)"
fi

# ------------------------------------------------------------------ compose --
log "starting the zapp dev stack (project: $PROJECT_NAME)"
if ! compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
  warn "compose failed to reach a healthy state."
  warn "port already in use? override it, e.g. ZAPP_LOCALSTACK_PORT=4567 ./scripts/dev-up.sh"
  warn "logs: docker compose -p $PROJECT_NAME -f $COMPOSE_FILE logs --tail 50"
  die "stack did not come up"
fi
log "all services healthy"

# ------------------------------------------------------------ minio bucket --
log "ensuring MinIO bucket '$ARTIFACT_BUCKET'"
compose exec -T minio mc --no-color alias set zapp-local \
  "http://127.0.0.1:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
compose exec -T minio mc --no-color mb --ignore-existing "zapp-local/$ARTIFACT_BUCKET" >/dev/null
compose exec -T minio mc --no-color ls "zapp-local/$ARTIFACT_BUCKET" >/dev/null ||
  die "MinIO bucket $ARTIFACT_BUCKET was not created"
log "bucket $ARTIFACT_BUCKET ready"

# -------------------------------------------------------- localstack queues --
log "verifying LocalStack queues"
found_queues="$(compose exec -T localstack awslocal sqs list-queues \
  --query 'QueueUrls[]' --output text | tr '\t' '\n' | sed 's#.*/##' | tr -d '\r')"
for queue in $EXPECTED_QUEUES; do
  printf '%s\n' "$found_queues" | grep -qx "$queue" ||
    die "LocalStack queue '$queue' is missing — see infra/docker/localstack/init-aws.sh"
done
log "6 queues present (3 queues + 3 DLQs)"

# ------------------------------------------------------------ db migrations --
if [ -d "$REPO_ROOT/packages/db" ]; then
  log "running database migrations"
  (cd "$REPO_ROOT" && pnpm db:migrate)
else
  log "skipping pnpm db:migrate — packages/db does not exist yet"
fi

# ----------------------------------------------------------- forgejo token --
forgejo_user_exists() {
  compose exec -T -u git forgejo forgejo admin user list 2>/dev/null |
    awk 'NR > 1 { print $2 }' | grep -qx "$FORGEJO_ADMIN_USER"
}

curl -fsS "http://127.0.0.1:${FORGEJO_HTTP_PORT}/api/healthz" >/dev/null ||
  die "Forgejo /api/healthz is not returning 200 on port $FORGEJO_HTTP_PORT"

existing_token=""
if [ -f "$FORGEJO_ENV_FILE" ]; then
  existing_token="$(sed -n 's/^FORGEJO_ADMIN_TOKEN=//p' "$FORGEJO_ENV_FILE" | head -1)"
fi

# A token from a previous run is only reusable if it still authenticates — after
# `down -v` the Forgejo volume is gone and the stored token is dead.
if [ -n "$existing_token" ] && curl -fs -o /dev/null \
  -H "Authorization: token ${existing_token}" \
  "http://127.0.0.1:${FORGEJO_HTTP_PORT}/api/v1/user"; then
  log "Forgejo admin token in $(basename "$FORGEJO_ENV_FILE") is still valid"
else
  admin_password=""
  if forgejo_user_exists; then
    log "Forgejo admin user '$FORGEJO_ADMIN_USER' already exists"
  else
    admin_password="$(random_hex)"
    log "creating Forgejo admin user '$FORGEJO_ADMIN_USER'"
    compose exec -T -u git forgejo forgejo admin user create \
      --admin --username "$FORGEJO_ADMIN_USER" --password "$admin_password" \
      --email "$FORGEJO_ADMIN_EMAIL" --must-change-password=false >/dev/null
  fi

  token="$(compose exec -T -u git forgejo forgejo admin user generate-access-token \
    --username "$FORGEJO_ADMIN_USER" --token-name "zapp-dev-$(date +%s)" \
    --scopes all --raw | tr -d '\r\n')"
  [ -n "$token" ] || die "failed to mint a Forgejo admin token"

  (
    umask 077
    {
      echo "# Generated by scripts/dev-up.sh — local dev only, never commit."
      echo "FORGEJO_URL=http://localhost:${FORGEJO_HTTP_PORT}"
      echo "FORGEJO_ADMIN_USER=${FORGEJO_ADMIN_USER}"
      echo "FORGEJO_ADMIN_TOKEN=${token}"
      if [ -n "$admin_password" ]; then
        echo "FORGEJO_ADMIN_PASSWORD=${admin_password}"
      fi
    } >"$FORGEJO_ENV_FILE"
  )
  log "wrote Forgejo admin token to $(basename "$FORGEJO_ENV_FILE") (gitignored)"
fi

# ------------------------------------------------------------------ summary --
cat <<SUMMARY

  zapp dev stack is up.

  Postgres        postgres://zapp:zapp@localhost:${POSTGRES_PORT}/zapp
  Redis           redis://localhost:${REDIS_PORT}
  Forgejo         http://localhost:${FORGEJO_HTTP_PORT}  (ssh: localhost:${FORGEJO_SSH_PORT})
  Temporal        localhost:${TEMPORAL_PORT}   UI http://localhost:${TEMPORAL_UI_PORT}
  MinIO           http://localhost:${MINIO_PORT}   console http://localhost:${MINIO_CONSOLE_PORT}
  LocalStack      http://localhost:${LOCALSTACK_PORT}

  Forgejo admin credentials: .env.local.forgejo
  Stop the stack:  docker compose -p ${PROJECT_NAME} -f infra/docker/docker-compose.dev.yml down
  Reset all data:  docker compose -p ${PROJECT_NAME} -f infra/docker/docker-compose.dev.yml down -v

SUMMARY
