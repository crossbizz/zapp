import { createHash } from 'node:crypto';

const BASELINE_SCHEMA_VERSION = 2;
const FIXTURE_SCHEMA_VERSION = 1;
const ACCEPTED_BASELINE_COMMIT = 'df81175a82ed9cb2d7508caafd291a2c26bc4794';
const ACCEPTED_BASELINE_TREE = '1b6e03ed3f396cc6597a7aea16468e1de2536699';
const ACCEPTED_ADR = 'docs/adr/0005-desktop-provider-migration-window.md';
const ACCEPTED_ADR_SHA256 = 'a6d53ba07e14f19d01971795c7c74ec2dec187e20bcd34fe1e9a6cd4a3bedcae';
const ACCEPTED_INVENTORY_SHA256 =
  '2b9a0e97a918d2789cdc133ef89f8821e277c495ec6caa5723a9a1ab04124fdf';
const ACCEPTED_REMOVAL_TASK = 'MAC-6';
const INVENTORY_CATEGORIES = ['providerCalls', 'providerImports', 'providerUses'];
const ACCEPTED_PATHS = [
  'apps/desktop/src/ipc/handlers/chat_stream_handlers.ts',
  'apps/desktop/src/ipc/handlers/compaction/compaction_handler.ts',
  'apps/desktop/src/ipc/handlers/help_bot_handlers.ts',
  'apps/desktop/src/ipc/services/provider_api_key_validation_service.ts',
  'apps/desktop/src/ipc/utils/get_model_client.ts',
  'apps/desktop/src/ipc/utils/llm_engine_provider.ts',
  'apps/desktop/src/ipc/utils/ollama_provider.ts',
  'apps/desktop/src/ipc/utils/provider_options.ts',
  'apps/desktop/src/ipc/utils/stream_text_utils.ts',
];
const REQUIRED_ADR_DECISIONS = [
  '# ADR-0005: Temporary desktop provider-call migration window',
  'Status: Accepted — controller decision 2026-08-04',
  'temporary, development-only exception',
  'sites that already exist under `apps/desktop` at the AR-1 parent commit',
  'exception ends when MAC-6 lands and never extends to new call sites',
  'becomes a zero-exception rule in the same commit that completes MAC-6',
  'No production distribution may pass the P0 release gate while the exception is\nactive',
  'The M2 exit checklist must fail if any direct provider exception remains',
];

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function inventoryDigest(files) {
  return sha256(JSON.stringify(canonicalValue(files)));
}

export function validateAcceptedAdr(adrText, baseline) {
  if (typeof adrText !== 'string') throw new Error('ADR-0005 content must be text');
  for (const decision of REQUIRED_ADR_DECISIONS) {
    if (!adrText.includes(decision)) {
      throw new Error(`ADR-0005 accepted decision is missing: ${decision}`);
    }
  }
  const digest = sha256(adrText);
  if (digest !== ACCEPTED_ADR_SHA256 || baseline.adrSha256 !== digest) {
    throw new Error(
      `ADR-0005 digest must remain ${ACCEPTED_ADR_SHA256}; use an explicit ADR migration to change it`,
    );
  }
}

export function validateBaseline(baseline, { accepted = false } = {}) {
  assertPlainObject(baseline, 'baseline');
  const requiredSchema = accepted ? BASELINE_SCHEMA_VERSION : FIXTURE_SCHEMA_VERSION;
  if (baseline.schemaVersion !== requiredSchema) {
    throw new Error(`baseline schemaVersion must be ${requiredSchema}`);
  }
  assertPlainObject(baseline.files, 'baseline.files');

  if (accepted) {
    if (baseline.adr !== ACCEPTED_ADR) {
      throw new Error(`accepted baseline ADR must be ${ACCEPTED_ADR}`);
    }
    if (baseline.adrSha256 !== ACCEPTED_ADR_SHA256) {
      throw new Error(`accepted baseline ADR digest must be ${ACCEPTED_ADR_SHA256}`);
    }
    if (baseline.baselineCommit !== ACCEPTED_BASELINE_COMMIT) {
      throw new Error(`accepted baseline commit must be ${ACCEPTED_BASELINE_COMMIT}`);
    }
    if (baseline.baselineTree !== ACCEPTED_BASELINE_TREE) {
      throw new Error(`accepted baseline tree must be ${ACCEPTED_BASELINE_TREE}`);
    }
    if (baseline.exceptionRemovalTask !== ACCEPTED_REMOVAL_TASK) {
      throw new Error(`accepted baseline removal task must be ${ACCEPTED_REMOVAL_TASK}`);
    }
    const actualPaths = Object.keys(baseline.files);
    if (!sameStrings(actualPaths, ACCEPTED_PATHS)) {
      throw new Error(
        `accepted baseline must contain exactly these nine paths: ${ACCEPTED_PATHS.join(', ')}`,
      );
    }
  }

  for (const [relativePath, inventory] of Object.entries(baseline.files)) {
    assertPlainObject(inventory, `baseline.files[${relativePath}]`);
    if (!sameStrings(Object.keys(inventory), INVENTORY_CATEGORIES)) {
      throw new Error(
        `baseline inventory for ${relativePath} must contain exactly ${INVENTORY_CATEGORIES.join(', ')}`,
      );
    }
    for (const category of INVENTORY_CATEGORIES) {
      assertPlainObject(inventory[category], `baseline ${relativePath} ${category}`);
      for (const [event, count] of Object.entries(inventory[category])) {
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error(`baseline count must be a positive integer: ${relativePath} ${event}`);
        }
      }
    }
  }

  if (accepted) {
    const digest = inventoryDigest(baseline.files);
    if (
      digest !== ACCEPTED_INVENTORY_SHA256 ||
      baseline.inventorySha256 !== ACCEPTED_INVENTORY_SHA256
    ) {
      throw new Error(
        `accepted baseline inventory digest must remain ${ACCEPTED_INVENTORY_SHA256}; migrate the anchor and ADR instead of blessing growth`,
      );
    }
  }
  return baseline.files;
}

function eventDetails(inventory) {
  return INVENTORY_CATEGORIES.flatMap((category) => Object.keys(inventory[category] ?? {})).join(
    ', ',
  );
}

export function compareToBaseline(inventory, baselineFiles) {
  const violations = [];
  const allPaths = new Set([...Object.keys(inventory), ...Object.keys(baselineFiles)]);
  for (const relativePath of [...allPaths].sort()) {
    const actual = inventory[relativePath];
    const allowed = baselineFiles[relativePath];
    if (!allowed) {
      violations.push(`new-provider path: ${relativePath} (${eventDetails(actual)})`);
      continue;
    }
    if (!actual) {
      violations.push(`baseline mismatch: ${relativePath} is absent; shrink the baseline now`);
      continue;
    }
    for (const category of INVENTORY_CATEGORIES) {
      const allEvents = new Set([
        ...Object.keys(actual[category] ?? {}),
        ...Object.keys(allowed[category] ?? {}),
      ]);
      for (const event of [...allEvents].sort()) {
        const foundCount = actual[category]?.[event] ?? 0;
        const allowedCount = allowed[category]?.[event] ?? 0;
        if (foundCount === allowedCount) continue;
        if (foundCount > allowedCount) {
          const violationKind =
            category === 'providerCalls'
              ? 'provider-call growth'
              : category === 'providerUses'
                ? 'provider-use growth'
                : 'provider-import growth';
          violations.push(
            `${violationKind}: ${relativePath} ${event} allowed ${allowedCount}, found ${foundCount}`,
          );
        } else {
          violations.push(
            `baseline mismatch: ${relativePath} ${event} allowed ${allowedCount}, found ${foundCount}; shrink the baseline now`,
          );
        }
      }
    }
  }
  return violations;
}

export const baselineConstantsForTests = {
  ACCEPTED_ADR_SHA256,
  ACCEPTED_BASELINE_COMMIT,
  ACCEPTED_BASELINE_TREE,
  ACCEPTED_INVENTORY_SHA256,
  ACCEPTED_PATHS,
  BASELINE_SCHEMA_VERSION,
};
