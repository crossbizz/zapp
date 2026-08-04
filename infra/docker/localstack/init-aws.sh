#!/usr/bin/env bash
# zapp.build — LocalStack bootstrap (FND-7).
#
# Mounted into /etc/localstack/init/ready.d/ so LocalStack runs it once the
# edge router is ready. It runs on every container start and is idempotent:
# existing queues are reused and their redrive policy is re-applied.
#
# Creates, for each logical queue, a `<name>` + `<name>-dlq` pair wired with a
# RedrivePolicy of maxReceiveCount=5, and verifies the dev SES sender.
set -euo pipefail

QUEUES="zapp-usage-events zapp-github-webhooks zapp-notifications"
MAX_RECEIVE_COUNT="${ZAPP_SQS_MAX_RECEIVE_COUNT:-5}"
SES_SENDER="${ZAPP_SES_SENDER:-dev@zapp.local}"

log() { echo "[zapp-init] $*"; }

# Prints the queue URL on stdout; logs go to stderr so callers can capture it.
ensure_queue() {
  queue_name="$1"
  queue_url="$(awslocal sqs get-queue-url --queue-name "$queue_name" \
    --query 'QueueUrl' --output text 2>/dev/null || true)"
  if [ -z "$queue_url" ] || [ "$queue_url" = "None" ]; then
    queue_url="$(awslocal sqs create-queue --queue-name "$queue_name" \
      --query 'QueueUrl' --output text)"
    log "created queue $queue_name" >&2
  else
    log "queue $queue_name already exists" >&2
  fi
  printf '%s' "$queue_url"
}

queue_arn() {
  awslocal sqs get-queue-attributes --queue-url "$1" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text
}

# RedrivePolicy is a JSON document passed as a JSON *string* value, so the inner
# quotes have to be escaped before it is embedded in the attributes map.
set_redrive_policy() {
  main_url="$1"
  dlq_arn="$2"
  policy="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' \
    "$dlq_arn" "$MAX_RECEIVE_COUNT")"
  escaped="${policy//\"/\\\"}"
  awslocal sqs set-queue-attributes --queue-url "$main_url" \
    --attributes "{\"RedrivePolicy\":\"${escaped}\"}"
}

for queue in $QUEUES; do
  dlq_url="$(ensure_queue "${queue}-dlq")"
  dlq_arn="$(queue_arn "$dlq_url")"
  main_url="$(ensure_queue "$queue")"
  set_redrive_policy "$main_url" "$dlq_arn"
  log "$queue -> DLQ $dlq_arn (maxReceiveCount=$MAX_RECEIVE_COUNT)"
done

# verify-email-identity is a no-op when the address is already verified.
awslocal ses verify-email-identity --email-address "$SES_SENDER"
log "verified SES sender $SES_SENDER"

log "ready: $(awslocal sqs list-queues --query 'length(QueueUrls)' --output text) queues"
