#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "$1" ]]; then
  printf 'usage: %s <evidence-path>\n' "$0" >&2
  exit 64
fi

readonly evidence_path="$1"
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

jq -s -e '
  length == 1 and
  (.[0] |
    .status == "restored" and
    (.branches | type) == "array" and
    (.refs | type) == "array" and
    .checkedBranches == (.branches | length) and
    all(.branches[]; .expectedSha == .actualSha)
  )
' "$temporary_path" >/dev/null

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
