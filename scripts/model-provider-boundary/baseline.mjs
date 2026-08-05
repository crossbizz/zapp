const BASELINE_SCHEMA_VERSION = 1;
const ACCEPTED_BASELINE_COMMIT = 'df81175a82ed9cb2d7508caafd291a2c26bc4794';
const ACCEPTED_ADR = 'docs/adr/0005-desktop-provider-migration-window.md';
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

export function validateBaseline(baseline, { accepted = false } = {}) {
  assertPlainObject(baseline, 'baseline');
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new Error(`baseline schemaVersion must be ${BASELINE_SCHEMA_VERSION}`);
  }
  assertPlainObject(baseline.files, 'baseline.files');

  if (accepted) {
    if (baseline.adr !== ACCEPTED_ADR) {
      throw new Error(`accepted baseline ADR must be ${ACCEPTED_ADR}`);
    }
    if (baseline.baselineCommit !== ACCEPTED_BASELINE_COMMIT) {
      throw new Error(`accepted baseline commit must be ${ACCEPTED_BASELINE_COMMIT}`);
    }
    if (baseline.exceptionRemovalTask !== ACCEPTED_REMOVAL_TASK) {
      throw new Error(`accepted baseline removal task must be ${ACCEPTED_REMOVAL_TASK}`);
    }
    const actualPaths = Object.keys(baseline.files);
    if (!sameStrings(actualPaths, ACCEPTED_PATHS)) {
      throw new Error(
        `accepted baseline must contain exactly these seven paths: ${ACCEPTED_PATHS.join(', ')}`,
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
        if (foundCount === allowedCount) {
          continue;
        }
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
  ACCEPTED_BASELINE_COMMIT,
  ACCEPTED_PATHS,
  BASELINE_SCHEMA_VERSION,
};
