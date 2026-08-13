import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatFeedbackTask, validateFeedbackRecord } from './record-feedback.mjs';

const AGENCY_ALIASES = Array.from({ length: 5 }, (_, index) => `beta-0${index + 1}`);
const CATEGORIES = [
  'reliability',
  'usability',
  'performance',
  'verification',
  'billing',
  'support',
];
const RESPONSE_TARGETS = [
  ['critical', 60],
  ['high', 240],
  ['medium', 1440],
  ['low', 4320],
];
const STATUSES = new Set(['candidate', 'active', 'paused', 'offboarded']);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, field) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const unknown = actual.find((key) => !wanted.includes(key));
  invariant(unknown === undefined, `unknown ${field} field: ${unknown}`);
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${field} fields are incomplete`);
}

export async function loadBetaTemplates(repositoryRoot) {
  const directory = path.join(repositoryRoot, 'validation', 'beta');
  const [cohort, rotation, feedback] = await Promise.all(
    ['cohort.json', 'support-rotation.json', 'feedback.json'].map(async (file) =>
      JSON.parse(await readFile(path.join(directory, file), 'utf8')),
    ),
  );
  return { cohort, rotation, feedback };
}

function validateCohort(cohort) {
  exactKeys(cohort, ['schemaVersion', 'agencies'], 'cohort');
  invariant(cohort?.schemaVersion === 1, 'cohort schemaVersion must be 1');
  invariant(
    Array.isArray(cohort?.agencies) && cohort.agencies.length === 5,
    'cohort must have five slots',
  );
  for (const [index, agency] of cohort.agencies.entries()) {
    exactKeys(
      agency,
      ['alias', 'status', 'onboardingEvidence', 'willingnessToPay'],
      `agencies[${index}]`,
    );
    invariant(agency?.alias === AGENCY_ALIASES[index], `agencies[${index}].alias is invalid`);
    invariant(STATUSES.has(agency?.status), `agencies[${index}].status is invalid`);
    invariant(
      Array.isArray(agency?.onboardingEvidence),
      `agencies[${index}].onboardingEvidence is required`,
    );
    agency.onboardingEvidence.forEach((item, evidenceIndex) =>
      invariant(
        typeof item === 'string' && /^onboarding_[A-Za-z0-9_-]{10,80}$/u.test(item),
        `agencies[${index}].onboardingEvidence[${evidenceIndex}] must be an opaque id`,
      ),
    );
    invariant(
      agency.willingnessToPay === null || typeof agency.willingnessToPay === 'boolean',
      `agencies[${index}].willingnessToPay is invalid`,
    );
  }
}

function validateRotation(rotation) {
  exactKeys(rotation, ['schemaVersion', 'responseTargets', 'assignments'], 'support rotation');
  invariant(rotation?.schemaVersion === 1, 'support rotation schemaVersion must be 1');
  invariant(
    JSON.stringify(
      rotation?.responseTargets?.map(({ severity, minutes }) => [severity, minutes]),
    ) === JSON.stringify(RESPONSE_TARGETS),
    'support response targets are invalid',
  );
  invariant(Array.isArray(rotation?.assignments), 'support assignments must be an array');
  for (const [index, target] of rotation.responseTargets.entries()) {
    exactKeys(target, ['severity', 'minutes'], `responseTargets[${index}]`);
  }
  for (const [index, assignment] of rotation.assignments.entries()) {
    exactKeys(
      assignment,
      ['id', 'startsAt', 'endsAt', 'primaryAlias', 'secondaryAlias'],
      `assignments[${index}]`,
    );
    invariant(/^rotation-\d{3}$/u.test(assignment?.id), `assignments[${index}].id is invalid`);
    invariant(
      !Number.isNaN(Date.parse(assignment?.startsAt)),
      `assignments[${index}].startsAt is invalid`,
    );
    invariant(
      !Number.isNaN(Date.parse(assignment?.endsAt)),
      `assignments[${index}].endsAt is invalid`,
    );
    invariant(
      Date.parse(assignment.startsAt) < Date.parse(assignment.endsAt),
      `assignments[${index}] must have a positive window`,
    );
    invariant(
      /^support-\d{2}$/u.test(assignment?.primaryAlias),
      `assignments[${index}].primaryAlias is invalid`,
    );
    invariant(
      /^support-\d{2}$/u.test(assignment?.secondaryAlias),
      `assignments[${index}].secondaryAlias is invalid`,
    );
    invariant(
      assignment.primaryAlias !== assignment.secondaryAlias,
      `assignments[${index}] requires two distinct responders`,
    );
  }
}

function validateFeedback(feedback) {
  exactKeys(feedback, ['schemaVersion', 'categories', 'records'], 'feedback');
  invariant(feedback?.schemaVersion === 1, 'feedback schemaVersion must be 1');
  invariant(
    JSON.stringify(feedback?.categories) === JSON.stringify(CATEGORIES),
    'feedback categories are invalid',
  );
  invariant(Array.isArray(feedback?.records), 'feedback records must be an array');
  const ids = new Set();
  for (const record of feedback.records) {
    validateFeedbackRecord(record);
    invariant(!ids.has(record.id), `duplicate feedback id: ${record.id}`);
    ids.add(record.id);
  }
}

export function validateBetaTemplates({ cohort, rotation, feedback }) {
  validateCohort(cohort);
  validateRotation(rotation);
  validateFeedback(feedback);
  return {
    agencies: cohort.agencies.length,
    responseTargets: rotation.responseTargets.length,
    feedbackCategories: feedback.categories.length,
  };
}

export function validateBetaReadiness({ cohort, rotation, feedback, tasksText, at = new Date() }) {
  validateBetaTemplates({ cohort, rotation, feedback });
  invariant(typeof tasksText === 'string', 'tasksText is required');
  const reasons = [];
  invariant(at instanceof Date && !Number.isNaN(at.valueOf()), 'readiness time is invalid');
  const active = cohort.agencies.filter(({ status }) => status === 'active');
  if (active.length < 3) reasons.push('fewer than three agencies are active');
  if (active.length > 5) reasons.push('more than five agencies are active');
  if (active.some(({ onboardingEvidence }) => onboardingEvidence.length === 0)) {
    reasons.push('active agency onboarding evidence is incomplete');
  }
  if (rotation.assignments.length === 0) {
    reasons.push('support rotation is unassigned');
  } else if (
    !rotation.assignments.some(
      ({ startsAt, endsAt }) =>
        Date.parse(startsAt) <= at.valueOf() && at.valueOf() < Date.parse(endsAt),
    )
  ) {
    reasons.push('support rotation does not cover the review time');
  }
  for (const agency of active) {
    const records = feedback.records.filter(({ agencyAlias }) => agencyAlias === agency.alias);
    if (records.length === 0) reasons.push(`${agency.alias} has no feedback record`);
    for (const record of records) {
      const expected = formatFeedbackTask(record);
      const taskLines = tasksText
        .split(/\r?\n/u)
        .map((line) => line.replace(/^- \[[ x]\] /u, '- [ ] '));
      if (!taskLines.includes(expected)) {
        reasons.push(`${record.id} is not linked into tasks`);
      }
    }
  }
  return {
    verdict: reasons.length === 0 ? 'ready' : 'blocked',
    activeAgencies: active.length,
    reasons,
  };
}

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const templates = await loadBetaTemplates(repositoryRoot);
  const validated = validateBetaTemplates(templates);
  const taskDirectory = path.join(repositoryRoot, 'tasks', 'beta-feedback');
  const taskFiles = (await readdir(taskDirectory)).filter((file) => /^BETA-\d{4}\.md$/u.test(file));
  const tasksText = (
    await Promise.all(taskFiles.map((file) => readFile(path.join(taskDirectory, file), 'utf8')))
  ).join('\n');
  const readiness = validateBetaReadiness({ ...templates, tasksText });
  process.stdout.write(
    `beta operations valid: ${validated.agencies} slots, ${validated.responseTargets} response targets, ${validated.feedbackCategories} categories; readiness ${readiness.verdict}\n`,
  );
  if (process.argv.includes('--require-ready') && readiness.verdict !== 'ready')
    process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
