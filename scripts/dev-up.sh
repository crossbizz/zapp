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

# Local-only MinIO root credentials — these are literals in
# docker-compose.dev.yml, so they are literals here too: reading them from the
# caller's environment would let an unrelated exported var break `mc alias set`.
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
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
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
command -v curl >/dev/null 2>&1 || die "curl is not installed — see docs/dev-setup.md"
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed — run 'corepack enable && corepack prepare pnpm@9.15.0 --activate'"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running — start Docker Desktop/OrbStack and retry"
[ -f "$COMPOSE_FILE" ] || die "missing $COMPOSE_FILE"

if [ ! -f "$REPO_ROOT/.env" ]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  # The template ships `replace-me` placeholders for the platform secrets. They
  # are below the services' length floors, so a copied-verbatim .env cannot boot
  # the control plane -- the developer's first `pnpm dev` fails on a variable
  # they were never told to change. Generate them here instead: local-only
  # values, regenerated whenever .env is deleted, never committed.
  #
  # SECRETS_MASTER_KEY is the odd one out: the vault decodes it as base64 of
  # exactly 32 bytes (`openssl rand -base64 32`), while the JWT secrets are hex.
  seed_secret() {
    # $1 = variable name, $2 = generated value. Portable in-place edit: BSD sed
    # (macOS) and GNU sed disagree about `-i`, so write through a temp file.
    local name="$1" value="$2" tmp
    tmp="$(mktemp)"
    awk -v n="$name" -v v="$value" \
      'index($0, n "=") == 1 { print n "=" v; next } { print }' \
      "$REPO_ROOT/.env" > "$tmp"
    mv "$tmp" "$REPO_ROOT/.env"
  }
  seed_secret SESSION_JWT_SECRET "$(openssl rand -hex 32)"
  seed_secret SERVICE_TOKEN_SECRET "$(openssl rand -hex 32)"
  seed_secret SECRETS_MASTER_KEY "$(openssl rand -base64 32)"
  chmod 600 "$REPO_ROOT/.env"
  log "created .env from .env.example with generated local secrets"
  log "  (add real provider keys — Stytch, Modal, model providers — as you need them)"
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

# ---------------------------------------------------- forgejo admin access --
FORGEJO_API="http://127.0.0.1:${FORGEJO_HTTP_PORT}"

forgejo_cli() { compose exec -T -u git forgejo forgejo "$@"; }

forgejo_user_exists() {
  forgejo_cli admin user list 2>/dev/null |
    awk 'NR > 1 { print $2 }' | grep -qx "$FORGEJO_ADMIN_USER"
}

forgejo_password_works() {
  curl -fs -o /dev/null -u "${FORGEJO_ADMIN_USER}:$1" "${FORGEJO_API}/api/v1/user"
}

env_file_value() { sed -n "s/^$1=//p" "$2" | head -1; }

curl -fsS "${FORGEJO_API}/api/healthz" >/dev/null ||
  die "Forgejo /api/healthz is not returning 200 on port $FORGEJO_HTTP_PORT"

stored_token=""
stored_token_name=""
stored_password=""
if [ -f "$FORGEJO_ENV_FILE" ]; then
  stored_token="$(env_file_value FORGEJO_ADMIN_TOKEN "$FORGEJO_ENV_FILE")"
  stored_token_name="$(env_file_value FORGEJO_ADMIN_TOKEN_NAME "$FORGEJO_ENV_FILE")"
  stored_password="$(env_file_value FORGEJO_ADMIN_PASSWORD "$FORGEJO_ENV_FILE")"
fi

# A token from a previous run is only reusable if it still authenticates — after
# `down -v` the Forgejo volume is gone and the stored token is dead.
if [ -n "$stored_token" ] && curl -fs -o /dev/null \
  -H "Authorization: token ${stored_token}" "${FORGEJO_API}/api/v1/user"; then
  log "Forgejo admin token in $(basename "$FORGEJO_ENV_FILE") is still valid"
else
  # The file is rewritten below, so the password has to survive the round trip:
  # it is the only copy, and an API token alone gets you no UI login.
  admin_password="$stored_password"
  if forgejo_user_exists; then
    if [ -n "$admin_password" ] && forgejo_password_works "$admin_password"; then
      log "Forgejo admin user '$FORGEJO_ADMIN_USER' already exists"
    else
      admin_password="$(random_hex)"
      log "resetting password for existing Forgejo admin '$FORGEJO_ADMIN_USER'"
      forgejo_cli admin user change-password --username "$FORGEJO_ADMIN_USER" \
        --password "$admin_password" --must-change-password=false >/dev/null
    fi
  else
    admin_password="$(random_hex)"
    log "creating Forgejo admin user '$FORGEJO_ADMIN_USER'"
    forgejo_cli admin user create --admin --username "$FORGEJO_ADMIN_USER" \
      --password "$admin_password" --email "$FORGEJO_ADMIN_EMAIL" \
      --must-change-password=false >/dev/null
  fi

  # Best effort: retire the previous all-scope token instead of letting them pile
  # up. Token endpoints need basic auth, which is why the password matters above.
  if [ -n "$stored_token_name" ] && curl -fs -o /dev/null -X DELETE \
    -u "${FORGEJO_ADMIN_USER}:${admin_password}" \
    "${FORGEJO_API}/api/v1/users/${FORGEJO_ADMIN_USER}/tokens/${stored_token_name}"; then
    log "revoked stale access token '$stored_token_name'"
  fi

  token_name="zapp-dev-$(date +%s)"
  token="$(forgejo_cli admin user generate-access-token \
    --username "$FORGEJO_ADMIN_USER" --token-name "$token_name" \
    --scopes all --raw | tr -d '\r\n')"
  [ -n "$token" ] || die "failed to mint a Forgejo admin token"

  (
    umask 077
    {
      echo "# Generated by scripts/dev-up.sh — local dev only, never commit."
      echo "FORGEJO_URL=http://localhost:${FORGEJO_HTTP_PORT}"
      echo "FORGEJO_ADMIN_USER=${FORGEJO_ADMIN_USER}"
      echo "FORGEJO_ADMIN_PASSWORD=${admin_password}"
      echo "FORGEJO_ADMIN_TOKEN_NAME=${token_name}"
      echo "FORGEJO_ADMIN_TOKEN=${token}"
    } >"$FORGEJO_ENV_FILE"
  )
  log "wrote Forgejo admin credentials to $(basename "$FORGEJO_ENV_FILE") (gitignored)"
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
