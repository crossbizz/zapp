#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <evidence-path>\n' "$0" >&2
  exit 64
fi

readonly evidence_path="$1"
: "${GIT_RESTORE_ORGANIZATION_ID:?GIT_RESTORE_ORGANIZATION_ID is required}"
: "${GIT_RESTORE_PROJECT_ID:?GIT_RESTORE_PROJECT_ID is required}"
evidence_directory="$(dirname -- "$evidence_path")"
readonly evidence_directory
evidence_name="$(basename -- "$evidence_path")"
readonly evidence_name

if [[ -e "$evidence_path" || -L "$evidence_path" ]]; then
  printf 'refusing to overwrite existing restore evidence\n' >&2
  exit 73
fi

temporary_path="$(mktemp "$evidence_directory/.${evidence_name}.tmp.XXXXXX")"
cleanup() {
  if [[ -n "$temporary_path" ]]; then
    rm -f -- "$temporary_path"
  fi
}
trap cleanup EXIT

pnpm --silent --filter @zapp/git-service exec tsx \
  --env-file-if-exists=../../.env.local.forgejo \
  scripts/backup.ts restore >"$temporary_path"

jq -s -e \
  --arg organization_id "$GIT_RESTORE_ORGANIZATION_ID" \
  --arg project_id "$GIT_RESTORE_PROJECT_ID" '
  def exact_keys($expected):
    type == "object" and ((keys | sort) == ($expected | sort));
  def full_sha:
    type == "string" and test("^[0-9A-Fa-f]{40}$");

  length == 1 and
  (.[0] as $result |
    ($result | exact_keys([
      "status",
      "organizationId",
      "projectId",
      "checkedBranches",
      "branches",
      "refs"
    ])) and
    $result.status == "restored" and
    $result.organizationId == $organization_id and
    $result.projectId == $project_id and
    ($result.checkedBranches | type) == "number" and
    ($result.checkedBranches | floor) == $result.checkedBranches and
    $result.checkedBranches >= 0 and
    ($result.branches | type) == "array" and
    ($result.refs | type) == "array" and
    $result.checkedBranches == ($result.branches | length) and
    all($result.branches[];
      exact_keys(["name", "expectedSha", "actualSha"]) and
      (.name | type) == "string" and
      (.expectedSha | full_sha) and
      (.actualSha | full_sha) and
      .expectedSha == .actualSha
    ) and
    all($result.refs[];
      exact_keys(["name", "sha"]) and
      (.name | type) == "string" and
      (.sha | full_sha)
    ) and
    ([$result.branches[].name] | unique | length) == ($result.branches | length) and
    ([$result.refs[].name] | unique | length) == ($result.refs | length)
  )
' "$temporary_path" >/dev/null

while IFS= read -r branch_name; do
  git check-ref-format "refs/heads/$branch_name" >/dev/null
done < <(jq -r '.branches[].name' "$temporary_path")

while IFS= read -r ref_name; do
  git check-ref-format "$ref_name" >/dev/null
done < <(jq -r '.refs[].name' "$temporary_path")

node - "$temporary_path" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const descriptor = fs.openSync(path, 'r');
try {
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
NODE

# The temp file is a same-directory inode. POSIX link publishes it atomically
# and refuses an existing destination, including one created after the check.
ln "$temporary_path" "$evidence_path"
rm -f -- "$temporary_path"
temporary_path=''

jq -r '.branches[] | [.name, .expectedSha, .actualSha] | @tsv' "$evidence_path"
jq -r '.refs[] | [.name, .sha] | @tsv' "$evidence_path"
