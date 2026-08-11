import { describe, expect, test, vi } from 'vitest';

import {
  GATE_IDS,
  buildCriteriaCompletionReport,
  type GateId,
  type GateResult,
  type SecretRedactor,
} from '../src/index.js';
import {
  EvidenceManifestSchema,
  assembleEvidenceManifest,
  persistEvidenceManifest,
  renderEvidenceReport,
} from '../src/evidence.js';

const RELEASE_ID = 'rel_01J00000000000000000000000';
const COMMIT_SHA = 'a'.repeat(40);
const IDENTITY_REDACTOR: SecretRedactor = { redact: (text) => text };

const REPORT_BY_GATE = {
  dev_server_start: 'Passed',
  production_build: 'Passed',
  typecheck: 'Passed',
  lint: 'Passed with 2 existing warnings',
  unit_tests: '48 passed, 0 failed',
  integration_tests: '12 passed, 0 failed',
  browser_smoke: '7 passed, 0 failed',
  browser_acceptance: '4 passed, 0 failed',
  authorization_tests: 'Passed',
  migration_validation: 'Passed',
  secret_scan: 'Passed',
  dependency_scan: '0',
  preview_health: 'Passed',
  rollback_readiness: 'Available',
  observability_check: 'Passed',
} as const satisfies Record<GateId, string>;

function artifactId(gateId: GateId): string {
  return `artifact-${gateId}`;
}

const GATE_RESULTS = GATE_IDS.map((gateId) => ({
  gateId,
  result: {
    status: 'passed' as const,
    evidenceArtifactIds: [artifactId(gateId)],
    details: {
      report: REPORT_BY_GATE[gateId],
      ...(gateId === 'migration_validation'
        ? { destructiveOperations: 'None', backwardCompatible: 'Yes' }
        : {}),
      ...(gateId === 'preview_health' ? { consoleErrorCount: 0 } : {}),
      ...(gateId === 'rollback_readiness'
        ? {
            previousDeployment: 'rel_01H00000000000000000000000',
            databaseCompatibility: 'Compatible',
          }
        : {}),
    },
  },
}));

const CRITERIA_COMPLETION = buildCriteriaCompletionReport({
  specificationVersion: 3,
  criteria: [
    { criterionId: 'AC-1' },
    { criterionId: 'AC-2', verifierComments: ['Awaiting provider sandbox.'] },
  ],
  tasks: [
    { taskId: 'TASK-1', acceptanceCriteriaIds: ['AC-1'] },
    { taskId: 'TASK-2', acceptanceCriteriaIds: ['AC-2'] },
  ],
  testCases: [
    {
      testCaseId: 'tcase_01',
      name: '[AC-1] completes checkout',
      status: 'passed',
      evidenceArtifactIds: ['art_ac1'],
    },
  ],
});

const ACCESSIBILITY_RESULT = {
  status: 'passed',
  evidenceArtifactIds: ['artifact-accessibility'],
  details: { report: 'Passed' },
} as const satisfies GateResult;

const RELEASE_CANDIDATE = {
  releaseId: RELEASE_ID,
  commitSha: COMMIT_SHA,
  specificationVersion: 3,
  supportLevel: 'managed',
  projectPolicy: { waivers: [] },
  gateResults: GATE_RESULTS,
  accessibilityResult: ACCESSIBILITY_RESULT,
  criteriaCompletion: CRITERIA_COMPLETION,
  criticalCriterionIds: [],
  policySignals: [],
  knownRisks: [
    {
      id: 'email-sandbox-only',
      detail: 'Email-provider delivery was tested in sandbox mode only.',
    },
  ],
} as const;

function expectedGate(gateId: GateId) {
  const gate = GATE_RESULTS.find((candidate) => candidate.gateId === gateId);
  if (gate === undefined) throw new Error(`missing fixture gate: ${gateId}`);
  const requirementClass = {
    dev_server_start: 'required',
    production_build: 'required',
    typecheck: 'required_or_explicit_waiver',
    lint: 'project_policy',
    unit_tests: 'required',
    integration_tests: 'required_for_managed_integrations',
    browser_smoke: 'required',
    browser_acceptance: 'required',
    authorization_tests: 'required_for_managed_auth',
    migration_validation: 'required',
    secret_scan: 'required',
    dependency_scan: 'required_policy',
    preview_health: 'required',
    rollback_readiness: 'required_for_supported_release_state',
    observability_check: 'required',
  } as const satisfies Record<GateId, string>;
  return {
    gateId,
    class: requirementClass[gateId],
    status: gate.result.status,
    evidenceArtifactIds: gate.result.evidenceArtifactIds,
  };
}

function expectedBlock(gateIds: readonly GateId[], includeAccessibility = false) {
  return {
    status: 'passed' as const,
    gates: [
      ...gateIds.map(expectedGate),
      ...(includeAccessibility
        ? [
            {
              gateId: 'accessibility',
              class: 'support_level_policy',
              status: 'passed',
              evidenceArtifactIds: ['artifact-accessibility'],
            } as const,
          ]
        : []),
    ],
  };
}

describe('VF-15 release evidence', () => {
  test('assembles the exact PRD manifest shape from gate results and the VF-9 completion record', () => {
    const manifest = assembleEvidenceManifest(RELEASE_CANDIDATE, IDENTITY_REDACTOR);

    expect(Object.keys(manifest)).toEqual([
      'release_id',
      'commit_sha',
      'specification_version',
      'criteria',
      'build',
      'typecheck',
      'tests',
      'browser_tests',
      'security',
      'migration',
      'preview',
      'rollback',
      'known_risks',
    ]);
    expect(manifest).toEqual({
      release_id: RELEASE_ID,
      commit_sha: COMMIT_SHA,
      specification_version: 3,
      criteria: CRITERIA_COMPLETION.criteria,
      build: expectedBlock(['production_build', 'lint']),
      typecheck: expectedBlock(['typecheck']),
      tests: expectedBlock(['unit_tests', 'integration_tests']),
      browser_tests: expectedBlock(['browser_smoke', 'browser_acceptance'], true),
      security: expectedBlock(['secret_scan', 'dependency_scan', 'authorization_tests']),
      migration: expectedBlock(['migration_validation']),
      preview: expectedBlock(['dev_server_start', 'preview_health', 'observability_check']),
      rollback: expectedBlock(['rollback_readiness']),
      known_risks: [
        {
          id: 'verification:0:criterion_unverified',
          detail: 'AC-2 has no conclusive verification evidence.',
        },
        ...RELEASE_CANDIDATE.knownRisks,
      ],
    });
    expect(EvidenceManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test('renders the Appendix D report while enumerating every gate and criterion', () => {
    expect(renderEvidenceReport(RELEASE_CANDIDATE, IDENTITY_REDACTOR)).toMatchInlineSnapshot(`
      "Release candidate: rel_01J00000000000000000000000
      Commit: aaaaaaa
      Specification: v3
      Support level: Managed

      Build
      - Production build: Passed
      - Type check: Passed
      - Lint policy: Passed with 2 existing warnings

      Tests
      - Unit: 48 passed, 0 failed
      - Integration: 12 passed, 0 failed
      - Browser: 7 passed, 0 failed
      - Browser acceptance: 4 passed, 0 failed
      - Accessibility critical routes: Passed

      Security
      - Secret scan: Passed
      - Critical dependency findings: 0
      - Authorization isolation tests: Passed

      Database
      - Migration dry run: Passed
      - Destructive operations: None
      - Backward compatible with previous release: Yes

      Preview
      - Development server: Passed
      - Readiness: Passed
      - Observability check: Passed
      - Console errors: 0

      Rollback
      - Previous deployment: rel_01H00000000000000000000000
      - Application rollback: Available
      - Database compatibility: Compatible

      Acceptance criteria
      - AC-1: Passed | tasks: TASK-1 | tests: tcase_01 | evidence: art_ac1 | comments: none
      - AC-2: Unverified | tasks: TASK-2 | tests: none | evidence: none | comments: Awaiting provider sandbox.

      Known risks
      - AC-2 has no conclusive verification evidence.
      - Email-provider delivery was tested in sandbox mode only.

      Verifier decision: Needs human"
    `);

    const report = renderEvidenceReport(RELEASE_CANDIDATE, IDENTITY_REDACTOR);
    for (const gateId of GATE_IDS) expect(report, gateId).toContain(REPORT_BY_GATE[gateId]);
    for (const criterion of CRITERIA_COMPLETION.criteria) {
      expect(report).toContain(criterion.criterionId);
    }
  });

  test('rejects a release candidate when any registered gate is missing', () => {
    expect(() =>
      assembleEvidenceManifest(
        {
          ...RELEASE_CANDIDATE,
          gateResults: GATE_RESULTS.filter(({ gateId }) => gateId !== 'observability_check'),
        },
        IDENTITY_REDACTOR,
      ),
    ).toThrow('evidence_gate_set_mismatch:observability_check');
  });

  test('uses the authoritative VF-10 rules and the actual VF-12 accessibility result', () => {
    const onePassingCriterion = {
      criteria: [CRITERIA_COMPLETION.criteria[0]],
      text: 'Authoritative VF-9 completion record for AC-1.',
    };
    const compatibleBestEffortFailure = {
      ...RELEASE_CANDIDATE,
      supportLevel: 'compatible' as const,
      criteriaCompletion: onePassingCriterion,
      gateResults: GATE_RESULTS.map((gate) =>
        gate.gateId === 'production_build'
          ? { ...gate, result: { ...gate.result, status: 'failed' as const } }
          : gate,
      ),
    };
    expect(renderEvidenceReport(compatibleBestEffortFailure, IDENTITY_REDACTOR)).toContain(
      'Verifier decision: Approved',
    );

    const missingRequiredEvidence = {
      ...RELEASE_CANDIDATE,
      criteriaCompletion: onePassingCriterion,
      gateResults: GATE_RESULTS.map((gate) =>
        gate.gateId === 'typecheck'
          ? { ...gate, result: { ...gate.result, evidenceArtifactIds: [] } }
          : gate,
      ),
    };
    expect(renderEvidenceReport(missingRequiredEvidence, IDENTITY_REDACTOR)).toContain(
      'Verifier decision: Rejected',
    );

    const failedAccessibility = {
      ...RELEASE_CANDIDATE,
      criteriaCompletion: onePassingCriterion,
      accessibilityResult: {
        status: 'failed' as const,
        evidenceArtifactIds: ['artifact-accessibility-failure'],
        details: { report: '1 critical violation' },
      },
    };
    const accessibilityReport = renderEvidenceReport(failedAccessibility, IDENTITY_REDACTOR);
    expect(accessibilityReport).toContain(
      'Accessibility critical routes: Failed: 1 critical violation',
    );
    expect(accessibilityReport).toContain('Verifier decision: Rejected');
  });

  test('redacts all returned and persisted text and never copies arbitrary gate details', async () => {
    const secret = 'provider-token-secret';
    const redactor: SecretRedactor = {
      redact: (text) => text.replaceAll(secret, '[REDACTED]'),
    };
    const candidate = {
      ...RELEASE_CANDIDATE,
      gateResults: GATE_RESULTS.map((gate) =>
        gate.gateId === 'production_build'
          ? {
              ...gate,
              result: {
                ...gate.result,
                details: { report: `Passed ${secret}`, rawProviderOutput: secret },
              },
            }
          : gate,
      ),
      knownRisks: [{ id: 'provider-risk', detail: `Sandbox only: ${secret}` }],
    };
    let storedBodyBytes: Uint8Array | undefined;
    const storeImmutableAndLinkRelease = vi.fn((input: { readonly body: Uint8Array }) => {
      storedBodyBytes = input.body;
      return Promise.resolve({ artifactId: 'art_01J00000000000000000000000' });
    });

    const manifest = assembleEvidenceManifest(candidate, redactor);
    const report = renderEvidenceReport(candidate, redactor);
    const persisted = await persistEvidenceManifest(candidate, redactor, {
      storeImmutableAndLinkRelease,
    });
    if (storedBodyBytes === undefined) throw new Error('expected persisted manifest bytes');
    const storedBody = new TextDecoder().decode(storedBodyBytes);

    expect(JSON.stringify(manifest)).not.toContain(secret);
    expect(JSON.stringify(manifest)).not.toContain('rawProviderOutput');
    expect(report).not.toContain(secret);
    expect(storedBody).not.toContain(secret);
    expect(JSON.stringify(persisted)).not.toContain(secret);
  });

  test('stores the manifest through one immutable-and-link operation', async () => {
    const storeImmutableAndLinkRelease = vi.fn(() =>
      Promise.resolve({ artifactId: 'art_01J00000000000000000000000' }),
    );

    const result = await persistEvidenceManifest(
      RELEASE_CANDIDATE,
      IDENTITY_REDACTOR,
      { storeImmutableAndLinkRelease },
    );

    const manifest = assembleEvidenceManifest(RELEASE_CANDIDATE, IDENTITY_REDACTOR);
    expect(storeImmutableAndLinkRelease).toHaveBeenCalledOnce();
    expect(storeImmutableAndLinkRelease).toHaveBeenCalledWith({
      releaseId: RELEASE_ID,
      expectedCommitSha: COMMIT_SHA,
      artifactType: 'release_evidence_manifest',
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(manifest)),
    });
    expect(result).toEqual({
      artifactId: 'art_01J00000000000000000000000',
      manifest,
      report: renderEvidenceReport(RELEASE_CANDIDATE, IDENTITY_REDACTOR),
    });
  });
});
