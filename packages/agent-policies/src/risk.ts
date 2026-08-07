/**
 * Best-effort speed bumps from ADR-0016. These expressions are intentionally
 * small. Once delivered, WS-11's network-profiled sandbox is the load-bearing
 * containment layer; this package does not provide command containment.
 */
export const COMMAND_DENY_PATTERNS = Object.freeze([
  /(?:^|\s)rm\s+-rf\s+\/(?:\s|$)/iu,
  /(?:^|\s)curl(?:\s|$)[^|\r\n]*\|\s*(?:ba|z)?sh(?:\s|$)/iu,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u,
]);

/** Small approval signals, not a SQL grammar. */
export const DESTRUCTIVE_SQL_PATTERNS = Object.freeze({
  always: Object.freeze([/\bdrop\s+table\b/iu, /\bdrop\s+column\b/iu, /\btruncate\b/iu]),
  deleteFrom: /\bdelete\s+from\b/iu,
  where: /\bwhere\b/iu,
});
