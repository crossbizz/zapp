import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadBetaTemplates, validateBetaReadiness, validateBetaTemplates } from './validate.mjs';
import { appendFeedbackTask, formatFeedbackTask } from './record-feedback.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

test('V-5 templates define five anonymous agency slots and fail closed before onboarding', async () => {
  const templates = await loadBetaTemplates(root);
  assert.deepEqual(validateBetaTemplates(templates), {
    agencies: 5,
    responseTargets: 4,
    feedbackCategories: 6,
  });
  const readiness = validateBetaReadiness({ ...templates, tasksText: '' });
  assert.equal(readiness.verdict, 'blocked');
  assert.ok(readiness.reasons.includes('fewer than three agencies are active'));
});

test('V-5 readiness requires active agencies, two-person support, and task-linked feedback', async () => {
  const templates = await loadBetaTemplates(root);
  const cohort = structuredClone(templates.cohort);
  const feedback = structuredClone(templates.feedback);
  const rotation = structuredClone(templates.rotation);
  for (const agency of cohort.agencies.slice(0, 3)) {
    agency.status = 'active';
    agency.onboardingEvidence = [`onboarding_${agency.alias}-accepted`];
    feedback.records.push({
      id: `BETA-${String(feedback.records.length + 1).padStart(4, '0')}`,
      agencyAlias: agency.alias,
      category: 'reliability',
      severity: 'high',
      productArea: 'builder',
      summaryCode: 'preview-timeout',
      externalReference: `feedback_${agency.alias}-entry`,
    });
  }
  rotation.assignments.push({
    id: 'rotation-001',
    startsAt: '2026-08-10T00:00:00.000Z',
    endsAt: '2026-08-17T00:00:00.000Z',
    primaryAlias: 'support-01',
    secondaryAlias: 'support-02',
  });
  const tasksText = feedback.records.map(formatFeedbackTask).join('\n');

  assert.equal(
    validateBetaReadiness({
      cohort,
      feedback,
      rotation,
      tasksText,
      at: new Date('2026-08-12T00:00:00.000Z'),
    }).verdict,
    'ready',
  );
});

test('V-5 feedback bridge appends one anonymous task idempotently', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-beta-feedback-'));
  const tasksPath = path.join(temporaryRoot, 'beta-feedback');
  const record = {
    id: 'BETA-0042',
    agencyAlias: 'beta-03',
    category: 'usability',
    severity: 'medium',
    productArea: 'deployment',
    summaryCode: 'rollback-copy-unclear',
    externalReference: 'feedback_01KZV800000000000000000000',
  };
  try {
    const outcomes = await Promise.all([
      appendFeedbackTask(record, tasksPath),
      appendFeedbackTask(record, tasksPath),
    ]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    const text = await readFile(path.join(tasksPath, 'BETA-0042.md'), 'utf8');
    assert.equal((text.match(/BETA-0042/gu) ?? []).length, 1);
    assert.doesNotMatch(text, /@|https?:/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('V-5 rejects identity-bearing or free-text feedback fields', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'zapp-beta-private-'));
  try {
    await assert.rejects(
      appendFeedbackTask(
        {
          id: 'BETA-0043',
          agencyAlias: 'beta-01',
          category: 'reliability',
          severity: 'high',
          productArea: 'builder',
          summaryCode: 'preview-timeout',
          externalReference: 'feedback_01KZV800000000000000000001',
          email: 'not-allowed@example.test',
        },
        path.join(temporaryRoot, 'tasks.md'),
      ),
      /unknown feedback field/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('V-5 rejects identity fields in the cohort and stale support coverage', async () => {
  const templates = await loadBetaTemplates(root);
  const withIdentity = structuredClone(templates);
  withIdentity.cohort.agencies[0].email = 'not-allowed@example.test';
  assert.throws(() => validateBetaTemplates(withIdentity), /unknown agencies\[0\] field/u);

  const cohort = structuredClone(templates.cohort);
  for (const agency of cohort.agencies.slice(0, 3)) {
    agency.status = 'active';
    agency.onboardingEvidence = [`onboarding_${agency.alias}-accepted`];
  }
  const rotation = structuredClone(templates.rotation);
  rotation.assignments.push({
    id: 'rotation-001',
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-08T00:00:00.000Z',
    primaryAlias: 'support-01',
    secondaryAlias: 'support-02',
  });
  const readiness = validateBetaReadiness({
    cohort,
    rotation,
    feedback: templates.feedback,
    tasksText: '',
    at: new Date('2026-08-12T00:00:00.000Z'),
  });
  assert.ok(readiness.reasons.includes('support rotation does not cover the review time'));
});
