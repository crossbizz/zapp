#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <evidence-path>\n' "$0" >&2
  exit 64
fi

readonly evidence_path="$1"

pnpm --silent --filter @zapp/git-service exec tsx \
  --env-file-if-exists=../../.env.local.forgejo \
  scripts/backup.ts restore >"$evidence_path"

jq -e '
  .status == "restored" and
  (.branches | type) == "array" and
  (.refs | type) == "array" and
  .checkedBranches == (.branches | length) and
  all(.branches[]; .expectedSha == .actualSha)
' "$evidence_path" >/dev/null

jq -r '.branches[] | [.name, .expectedSha, .actualSha] | @tsv' "$evidence_path"
jq -r '.refs[] | [.name, .sha] | @tsv' "$evidence_path"
