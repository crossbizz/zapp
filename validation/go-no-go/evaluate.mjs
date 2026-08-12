import { access, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_THRESHOLDS = [
  ['T1', 'templatePreviewRate', 'Supported template reaches preview', '>', 0.9],
  ['T2', 'importedPreviewRate', 'Imported compatible project reaches preview', '>', 0.7],
  [
    'T3',
    'scopedBuildWithinOneRepairRate',
    'Scoped Build tasks pass after at most one repair loop',
    '>',
    0.75,
  ],
  [
    'T4',
    'criticalBrowserFlowPassRate',
    'Critical browser flows pass before Verified release',
    '=',
    1,
  ],
  ['T5', 'exactRollbackRate', 'Verified releases with exact rollback target', '=', 1],
  [
    'T6',
    'escapedCriticalRegressionRate',
    'Escaped critical regression in declared critical flows',
    '<',
    0.05,
  ],
  ['T7', 'modelModalCostShare', 'Model plus Modal cost', '<', 0.25],
  ['T8', 'agencyWillingToPay', 'Private-beta agencies willing to pay', '>=', 3],
];

const EXPECTED_INVALIDATION_SIGNALS = [
  'Most users bypass specification and verification.',
  'Human code edits are required for most tasks.',
  'Verification cost exceeds user willingness to pay.',
  'Modal setup and restore latency makes the product feel slower than alternatives without improving reliability.',
  'Broad framework support causes unsustainable support load.',
  'Generated tests produce high false confidence.',
  'Each deployed application becomes a bespoke services engagement.',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRepositoryArtifact(repositoryRoot, relativePath, field) {
  invariant(
    typeof relativePath === 'string' &&
      relativePath.trim().length > 0 &&
      !path.isAbsolute(relativePath) &&
      relativePath.split(/[\\/]/u).every((segment) => segment !== '..'),
    `${field} must be repository-relative`,
  );
  const canonicalRoot = await realpath(repositoryRoot);
  const candidate = path.resolve(repositoryRoot, relativePath);
  await access(candidate);
  const canonicalCandidate = await realpath(candidate);
  invariant(
    canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`),
    `${field} must resolve inside the repository`,
  );
}

export async function loadGoNoGoPolicy(repositoryRoot) {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, 'validation', 'go-no-go', 'policy.json'), 'utf8'),
  );
}

export function validateGoNoGoPolicy(policy) {
  invariant(policy?.schemaVersion === 1, 'go/no-go policy schemaVersion must be 1');
  invariant(
    JSON.stringify(policy?.sources) === JSON.stringify(['PRD-37.6', 'PRD-40.4']),
    'go/no-go policy sources must be PRD-37.6 and PRD-40.4',
  );
  invariant(Array.isArray(policy?.thresholds), 'thresholds must be an array');
  invariant(policy.thresholds.length === 8, 'policy must contain exactly eight thresholds');
  for (const [index, expected] of EXPECTED_THRESHOLDS.entries()) {
    const threshold = policy.thresholds[index];
    invariant(
      JSON.stringify([
        threshold?.id,
        threshold?.metric,
        threshold?.label,
        threshold?.operator,
        threshold?.target,
      ]) === JSON.stringify(expected),
      `thresholds[${index}] must match PRD §37.6`,
    );
  }
  invariant(
    policy.thresholds[7]?.denominatorExact === 5,
    'agency willingness threshold must use the first five agencies',
  );
  invariant(
    Array.isArray(policy?.invalidationSignals) && policy.invalidationSignals.length === 7,
    'policy must contain exactly seven invalidation signals',
  );
  for (const [index, signal] of policy.invalidationSignals.entries()) {
    invariant(signal?.id === `I${index + 1}`, `invalidationSignals[${index}].id is invalid`);
    invariant(
      signal?.signal === EXPECTED_INVALIDATION_SIGNALS[index],
      `invalidationSignals[${index}] must match PRD §40.4`,
    );
  }
  return { thresholds: policy.thresholds.length, invalidationSignals: 7 };
}

function ratio(value, metric) {
  invariant(value && typeof value === 'object', `${metric} must be a measurement`);
  invariant(
    Number.isInteger(value.numerator) && value.numerator >= 0,
    `${metric}.numerator must be a non-negative integer`,
  );
  invariant(
    Number.isInteger(value.denominator) && value.denominator > 0,
    `${metric}.denominator must be a positive integer`,
  );
  return value.numerator / value.denominator;
}

function passes(actual, operator, target) {
  if (operator === '>') return actual > target;
  if (operator === '<') return actual < target;
  if (operator === '=') return actual === target;
  if (operator === '>=') return actual >= target;
  throw new Error(`unsupported threshold operator: ${operator}`);
}

export function evaluateGoNoGo(input, policy) {
  validateGoNoGoPolicy(policy);
  invariant(input?.schemaVersion === 1, 'go/no-go input schemaVersion must be 1');
  invariant(Array.isArray(input?.sourceArtifacts), 'sourceArtifacts must be an array');
  const evidenceKinds = new Set();
  input.sourceArtifacts.forEach((artifact, index) => {
    invariant(
      artifact && typeof artifact === 'object',
      `sourceArtifacts[${index}] must be an artifact reference`,
    );
    invariant(
      typeof artifact.path === 'string' && artifact.path.trim().length > 0,
      `sourceArtifacts[${index}].path must be non-empty`,
    );
    invariant(
      artifact.kind === 'repeat-change-results' || artifact.kind === 'agency-validation-results',
      `sourceArtifacts[${index}].kind is invalid`,
    );
    invariant(
      typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(artifact.sha256),
      `sourceArtifacts[${index}].sha256 is invalid`,
    );
    evidenceKinds.add(artifact.kind);
  });
  const missingEvidenceKinds = ['repeat-change-results', 'agency-validation-results'].filter(
    (kind) => !evidenceKinds.has(kind),
  );
  invariant(
    Array.isArray(input?.invalidationSignals) && input.invalidationSignals.length === 7,
    'go/no-go input must review all seven invalidation signals',
  );
  const incompleteInvalidationSignals = [];
  const observedInvalidationSignals = [];
  for (const [index, expected] of policy.invalidationSignals.entries()) {
    const signal = input.invalidationSignals[index];
    invariant(signal?.id === expected.id, `invalidationSignals[${index}].id is invalid`);
    invariant(
      Array.isArray(signal?.evidence),
      `invalidationSignals[${index}].evidence is required`,
    );
    if (typeof signal.observed !== 'boolean') {
      incompleteInvalidationSignals.push(signal.id);
    } else if (signal.observed) {
      invariant(
        signal.evidence.length > 0,
        `observed invalidation signal ${signal.id} requires evidence`,
      );
      signal.evidence.forEach((item, evidenceIndex) =>
        invariant(
          typeof item === 'string' && item.trim().length > 0,
          `invalidationSignals[${index}].evidence[${evidenceIndex}] must be non-empty`,
        ),
      );
      observedInvalidationSignals.push(signal.id);
    }
  }
  const metrics = input.metrics;
  const missingMetrics = policy.thresholds
    .map((threshold) => threshold.metric)
    .filter((metric) => metrics?.[metric] === undefined || metrics[metric] === null);
  if (
    missingMetrics.length > 0 ||
    missingEvidenceKinds.length > 0 ||
    incompleteInvalidationSignals.length > 0
  ) {
    return {
      verdict: 'blocked',
      missingMetrics,
      missingEvidenceKinds,
      incompleteInvalidationSignals,
      observedInvalidationSignals,
      results: [],
    };
  }

  const results = policy.thresholds.map((threshold) => {
    const measurement = metrics[threshold.metric];
    const measuredRatio = ratio(measurement, threshold.metric);
    if (threshold.metric !== 'modelModalCostShare') {
      invariant(
        measurement.numerator <= measurement.denominator,
        `${threshold.metric}.numerator cannot exceed its denominator`,
      );
    }
    if (threshold.denominatorExact !== undefined) {
      invariant(
        measurement.denominator === threshold.denominatorExact,
        `${threshold.metric} must measure the first five agencies`,
      );
    }
    const actual = threshold.denominatorExact === undefined ? measuredRatio : measurement.numerator;
    return {
      id: threshold.id,
      metric: threshold.metric,
      actual,
      passed: passes(actual, threshold.operator, threshold.target),
    };
  });
  return {
    verdict:
      results.every((result) => result.passed) && observedInvalidationSignals.length === 0
        ? 'go'
        : 'no-go',
    missingMetrics: [],
    missingEvidenceKinds: [],
    incompleteInvalidationSignals: [],
    observedInvalidationSignals,
    results,
  };
}

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const policy = await loadGoNoGoPolicy(repositoryRoot);
  const validated = validateGoNoGoPolicy(policy);
  const resultsPath = process.argv[2];
  if (resultsPath === undefined) {
    process.stdout.write(
      `go/no-go policy valid: ${validated.thresholds} thresholds, ${validated.invalidationSignals} invalidation signals\n`,
    );
    return;
  }
  const input = JSON.parse(await readFile(path.resolve(resultsPath), 'utf8'));
  for (const [index, artifact] of (input.sourceArtifacts ?? []).entries()) {
    await assertRepositoryArtifact(repositoryRoot, artifact.path, `sourceArtifacts[${index}].path`);
    const bytes = await readFile(path.resolve(repositoryRoot, artifact.path));
    const digest = createHash('sha256').update(bytes).digest('hex');
    invariant(digest === artifact.sha256, `sourceArtifacts[${index}] SHA-256 mismatch`);
    let source;
    try {
      source = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`sourceArtifacts[${index}] must be JSON`);
    }
    invariant(
      source?.schemaVersion === 1 && source?.kind === artifact.kind,
      `sourceArtifacts[${index}] kind does not match its content`,
    );
  }
  for (const [signalIndex, signal] of (input.invalidationSignals ?? []).entries()) {
    for (const [evidenceIndex, artifact] of (signal.evidence ?? []).entries()) {
      await assertRepositoryArtifact(
        repositoryRoot,
        artifact,
        `invalidationSignals[${signalIndex}].evidence[${evidenceIndex}]`,
      );
    }
  }
  const evaluation = evaluateGoNoGo(input, policy);
  process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
  if (evaluation.verdict === 'blocked') process.exitCode = 2;
  if (evaluation.verdict === 'no-go') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
