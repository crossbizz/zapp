import { CommitShaSchema, SupportLevelSchema, idSchema } from '@zapp/contracts';
import { z } from 'zod';

import {
  CriteriaCompletionReportSchema,
  CriterionIdSchema,
  CriterionRecordSchema,
  type CriterionRecord,
} from './criteria.js';
import {
  GateResultSchema,
  type GateResult,
  type SecretRedactor,
} from './gates/registry.js';
import {
  GATE_IDS,
  GateIdSchema,
  GateRequirementClassSchema,
  GateWaiverSchema,
  ProjectPolicySchema,
  requiredGates,
  type GateId,
} from './policy-matrix.js';
import { PolicySignalSchema } from './anti-slop/placeholder.js';
import {
  GateEvaluationSchema,
  decideVerification,
  type GateEvaluation,
  type VerificationDecision,
} from './verifier/decision.js';

export const EvidenceKnownRiskSchema = z
  .object({
    id: z.string().trim().min(1).max(1_024),
    detail: z.string().trim().min(1).max(10_000),
  })
  .strict();
export type EvidenceKnownRisk = z.infer<typeof EvidenceKnownRiskSchema>;

const EvidenceKnownRisksSchema = z
  .array(EvidenceKnownRiskSchema)
  .max(2_000)
  .superRefine((risks, context) => {
    const ids = risks.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence_duplicate_risk' });
    }
  });

export const ReleaseGateResultSchema = z
  .object({ gateId: GateIdSchema, result: GateResultSchema })
  .strict();
export type ReleaseGateResult = z.infer<typeof ReleaseGateResultSchema>;

export const ReleaseEvidenceCandidateSchema = z
  .object({
    releaseId: idSchema('rel'),
    commitSha: CommitShaSchema,
    specificationVersion: z.number().int().positive(),
    supportLevel: SupportLevelSchema,
    projectPolicy: ProjectPolicySchema,
    gateResults: z.array(ReleaseGateResultSchema).max(GATE_IDS.length),
    accessibilityResult: GateResultSchema,
    criteriaCompletion: CriteriaCompletionReportSchema,
    criticalCriterionIds: z.array(CriterionIdSchema).max(1_000),
    policySignals: z.array(PolicySignalSchema).max(9),
    knownRisks: z.array(EvidenceKnownRiskSchema).max(1_000),
  })
  .strict()
  .superRefine((candidate, context) => {
    const counts = new Map<GateId, number>();
    for (const { gateId } of candidate.gateResults) {
      counts.set(gateId, (counts.get(gateId) ?? 0) + 1);
    }
    const mismatched = GATE_IDS.filter((gateId) => counts.get(gateId) !== 1);
    if (mismatched.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gateResults'],
        message: `evidence_gate_set_mismatch:${mismatched.join(',')}`,
      });
    }

    const criterionIds = candidate.criteriaCompletion.criteria.map(({ criterionId }) => criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteriaCompletion', 'criteria'],
        message: 'evidence_duplicate_criterion',
      });
    }
    for (const [index, criterion] of candidate.criteriaCompletion.criteria.entries()) {
      if (criterion.specificationVersion !== candidate.specificationVersion) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteriaCompletion', 'criteria', index, 'specificationVersion'],
          message: `evidence_criterion_specification_mismatch:${criterion.criterionId}`,
        });
      }
    }
    if (candidate.accessibilityResult.status === 'waived') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessibilityResult', 'status'],
        message: 'evidence_accessibility_waiver_unsupported',
      });
    }
  });
export type ReleaseEvidenceCandidate = z.infer<typeof ReleaseEvidenceCandidateSchema>;

const EvidenceRegisteredGateSchema = z
  .object({
    gateId: GateIdSchema,
    class: GateRequirementClassSchema,
    status: GateResultSchema.shape.status,
    evidenceArtifactIds: z.array(z.string().min(1)).max(10_000),
    waiver: GateWaiverSchema.optional(),
  })
  .strict();

const EvidenceAccessibilityGateSchema = z
  .object({
    gateId: z.literal('accessibility'),
    class: z.literal('support_level_policy'),
    status: GateResultSchema.shape.status,
    evidenceArtifactIds: z.array(z.string().min(1)).max(10_000),
  })
  .strict();

export const EvidenceGateRecordSchema = z.union([
  EvidenceRegisteredGateSchema,
  EvidenceAccessibilityGateSchema,
]);
export type EvidenceGateRecord = z.infer<typeof EvidenceGateRecordSchema>;

export const EvidenceGateBlockSchema = z
  .object({
    status: GateResultSchema.shape.status,
    gates: z.array(EvidenceGateRecordSchema).min(1).max(GATE_IDS.length + 1),
  })
  .strict();
export type EvidenceGateBlock = z.infer<typeof EvidenceGateBlockSchema>;

export const EvidenceManifestSchema = z
  .object({
    release_id: idSchema('rel'),
    commit_sha: CommitShaSchema,
    specification_version: z.number().int().positive(),
    criteria: z.array(CriterionRecordSchema).min(1).max(1_000),
    build: EvidenceGateBlockSchema,
    typecheck: EvidenceGateBlockSchema,
    tests: EvidenceGateBlockSchema,
    browser_tests: EvidenceGateBlockSchema,
    security: EvidenceGateBlockSchema,
    migration: EvidenceGateBlockSchema,
    preview: EvidenceGateBlockSchema,
    rollback: EvidenceGateBlockSchema,
    known_risks: EvidenceKnownRisksSchema,
  })
  .strict();
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

const SECTION_GATES = {
  build: ['production_build', 'lint'],
  typecheck: ['typecheck'],
  tests: ['unit_tests', 'integration_tests'],
  browser_tests: ['browser_smoke', 'browser_acceptance'],
  security: ['secret_scan', 'dependency_scan', 'authorization_tests'],
  migration: ['migration_validation'],
  preview: ['dev_server_start', 'preview_health', 'observability_check'],
  rollback: ['rollback_readiness'],
} as const satisfies Record<
  | 'build'
  | 'typecheck'
  | 'tests'
  | 'browser_tests'
  | 'security'
  | 'migration'
  | 'preview'
  | 'rollback',
  readonly GateId[]
>;

interface ResolvedEvidenceCandidate {
  readonly candidate: ReleaseEvidenceCandidate;
  readonly evaluations: readonly GateEvaluation[];
  readonly evaluationsById: ReadonlyMap<GateId, GateEvaluation>;
  readonly decision: VerificationDecision;
  readonly knownRisks: readonly EvidenceKnownRisk[];
}

function accessibilityRisk(
  candidate: ReleaseEvidenceCandidate,
): { readonly blocking: boolean; readonly risk?: EvidenceKnownRisk } {
  const result = candidate.accessibilityResult;
  if (result.status === 'failed') {
    return {
      blocking: true,
      risk: {
        id: 'verification:accessibility_failed',
        detail: 'Accessibility verification failed for release-critical routes.',
      },
    };
  }
  if (result.status === 'passed' && result.evidenceArtifactIds.length === 0) {
    return {
      blocking: true,
      risk: {
        id: 'verification:accessibility_evidence_missing',
        detail: 'Accessibility verification reported success without an evidence artifact.',
      },
    };
  }
  if (result.status === 'not_applicable') {
    const blocking = candidate.supportLevel !== 'compatible';
    return {
      blocking,
      risk: {
        id: 'verification:accessibility_not_applicable',
        detail: blocking
          ? 'Accessibility verification was required but returned not applicable.'
          : 'Accessibility verification returned not applicable.',
      },
    };
  }
  return { blocking: false };
}

function resolveCandidate(candidateValue: unknown): ResolvedEvidenceCandidate {
  const candidate = ReleaseEvidenceCandidateSchema.parse(candidateValue);
  const resultsById = new Map(
    candidate.gateResults.map(({ gateId, result }) => [gateId, result]),
  );
  const evaluations = requiredGates(candidate.supportLevel, candidate.projectPolicy).map(
    (requirement) => {
      const result = resultsById.get(requirement.gateId);
      if (result === undefined) throw new Error(`evidence_gate_missing:${requirement.gateId}`);
      return GateEvaluationSchema.parse(
        requirement.disposition === 'waived'
          ? {
              gateId: requirement.gateId,
              class: requirement.class,
              result,
              waiver: requirement.waiver,
            }
          : { gateId: requirement.gateId, class: requirement.class, result },
      );
    },
  );
  const verifier = decideVerification({
    gateEvaluations: evaluations,
    criteria: candidate.criteriaCompletion.criteria,
    criticalCriterionIds: candidate.criticalCriterionIds,
    policySignals: candidate.policySignals,
  });
  const accessibility = accessibilityRisk(candidate);
  const decision = accessibility.blocking ? 'rejected' : verifier.decision;
  const verifierRisks = verifier.risks.map((risk, index) => ({
    id: `verification:${String(index)}:${risk.code}`,
    detail: risk.summary,
  }));
  const knownRisks = EvidenceKnownRisksSchema.parse([
    ...verifierRisks,
    ...(accessibility.risk === undefined ? [] : [accessibility.risk]),
    ...candidate.knownRisks,
  ]);
  return {
    candidate,
    evaluations,
    evaluationsById: new Map(evaluations.map((evaluation) => [evaluation.gateId, evaluation])),
    decision,
    knownRisks,
  };
}

function redact(redactor: SecretRedactor, value: string): string {
  return redactor.redact(value);
}

function redactedCriterion(
  criterion: CriterionRecord,
  redactor: SecretRedactor,
): CriterionRecord {
  return CriterionRecordSchema.parse({
    ...criterion,
    taskIds: criterion.taskIds.map((value) => redact(redactor, value)),
    testCaseIds: criterion.testCaseIds.map((value) => redact(redactor, value)),
    evidenceArtifactIds: criterion.evidenceArtifactIds.map((value) => redact(redactor, value)),
    verifierComments: criterion.verifierComments.map((value) => redact(redactor, value)),
  });
}

function redactedGate(
  evaluation: GateEvaluation,
  redactor: SecretRedactor,
): z.infer<typeof EvidenceRegisteredGateSchema> {
  return EvidenceRegisteredGateSchema.parse({
    gateId: evaluation.gateId,
    class: evaluation.class,
    status: evaluation.result.status,
    evidenceArtifactIds: evaluation.result.evidenceArtifactIds.map((value) =>
      redact(redactor, value),
    ),
    ...(evaluation.waiver === undefined
      ? {}
      : {
          waiver: {
            ...evaluation.waiver,
            reason: redact(redactor, evaluation.waiver.reason),
          },
        }),
  });
}

function redactedAccessibilityGate(
  result: GateResult,
  redactor: SecretRedactor,
): z.infer<typeof EvidenceAccessibilityGateSchema> {
  return EvidenceAccessibilityGateSchema.parse({
    gateId: 'accessibility',
    class: 'support_level_policy',
    status: result.status,
    evidenceArtifactIds: result.evidenceArtifactIds.map((value) => redact(redactor, value)),
  });
}

function redactedRisk(risk: EvidenceKnownRisk, redactor: SecretRedactor): EvidenceKnownRisk {
  return EvidenceKnownRiskSchema.parse({
    id: redact(redactor, risk.id),
    detail: redact(redactor, risk.detail),
  });
}

function aggregateStatus(
  gates: readonly EvidenceGateRecord[],
): z.infer<typeof GateResultSchema>['status'] {
  if (gates.some(({ status }) => status === 'failed')) return 'failed';
  if (gates.some(({ status }) => status === 'waived')) return 'waived';
  if (gates.some(({ status }) => status === 'not_applicable')) return 'not_applicable';
  return 'passed';
}

function block(
  gatesById: ReadonlyMap<GateId, z.infer<typeof EvidenceRegisteredGateSchema>>,
  gateIds: readonly GateId[],
  supplemental: readonly EvidenceGateRecord[] = [],
): EvidenceGateBlock {
  const gates: EvidenceGateRecord[] = [
    ...gateIds.map((gateId) => {
      const gate = gatesById.get(gateId);
      if (gate === undefined) throw new Error(`evidence_gate_missing:${gateId}`);
      return gate;
    }),
    ...supplemental,
  ];
  return EvidenceGateBlockSchema.parse({ status: aggregateStatus(gates), gates });
}

export function assembleEvidenceManifest(
  candidateValue: unknown,
  redactor: SecretRedactor,
): EvidenceManifest {
  const resolved = resolveCandidate(candidateValue);
  const redactedGates = resolved.evaluations.map((evaluation) =>
    redactedGate(evaluation, redactor),
  );
  const gatesById = new Map(redactedGates.map((gate) => [gate.gateId, gate]));
  const accessibility = redactedAccessibilityGate(
    resolved.candidate.accessibilityResult,
    redactor,
  );
  return EvidenceManifestSchema.parse({
    release_id: resolved.candidate.releaseId,
    commit_sha: resolved.candidate.commitSha,
    specification_version: resolved.candidate.specificationVersion,
    criteria: resolved.candidate.criteriaCompletion.criteria.map((criterion) =>
      redactedCriterion(criterion, redactor),
    ),
    build: block(gatesById, SECTION_GATES.build),
    typecheck: block(gatesById, SECTION_GATES.typecheck),
    tests: block(gatesById, SECTION_GATES.tests),
    browser_tests: block(gatesById, SECTION_GATES.browser_tests, [accessibility]),
    security: block(gatesById, SECTION_GATES.security),
    migration: block(gatesById, SECTION_GATES.migration),
    preview: block(gatesById, SECTION_GATES.preview),
    rollback: block(gatesById, SECTION_GATES.rollback),
    known_risks: resolved.knownRisks.map((risk) => redactedRisk(risk, redactor)),
  });
}

function oneLine(value: string, redactor: SecretRedactor): string {
  return redact(redactor, value).replace(/\s+/gu, ' ').trim();
}

function displayedStatus(status: z.infer<typeof GateResultSchema>['status']): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'waived':
      return 'Waived';
    case 'not_applicable':
      return 'Not applicable';
  }
}

function reportValue(
  input: {
    readonly result: GateResult;
    readonly waiver?: z.infer<typeof GateWaiverSchema> | undefined;
  },
  redactor: SecretRedactor,
): string {
  if (input.result.status === 'waived' && input.waiver !== undefined) {
    return `Waived by ${input.waiver.actorId}: ${oneLine(input.waiver.reason, redactor)}`;
  }
  if (input.result.status === 'not_applicable') return 'Not applicable';
  const report = input.result.details['report'];
  const detail =
    typeof report === 'string' && report.trim().length > 0
      ? oneLine(report, redactor)
      : undefined;
  if (input.result.status === 'failed') {
    return detail === undefined ? 'Failed' : `Failed: ${detail}`;
  }
  return detail ?? displayedStatus(input.result.status);
}

function detailValue(
  result: GateResult,
  key: string,
  redactor: SecretRedactor,
): string {
  const value = result.details[key];
  if (typeof value === 'string' && value.trim().length > 0) return oneLine(value, redactor);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return 'Unknown';
}

function list(values: readonly string[], redactor: SecretRedactor): string {
  return values.length === 0 ? 'none' : values.map((value) => oneLine(value, redactor)).join(', ');
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');
}

export function renderEvidenceReport(
  candidateValue: unknown,
  redactor: SecretRedactor,
): string {
  const resolved = resolveCandidate(candidateValue);
  const gate = (gateIdValue: unknown): GateEvaluation => {
    const gateId = GateIdSchema.parse(gateIdValue);
    const evaluation = resolved.evaluationsById.get(gateId);
    if (evaluation === undefined) throw new Error(`evidence_gate_missing:${gateId}`);
    return evaluation;
  };
  const migration = gate('migration_validation');
  const preview = gate('preview_health');
  const rollback = gate('rollback_readiness');
  const criteriaLines = resolved.candidate.criteriaCompletion.criteria.map(
    (criterion) =>
      `- ${criterion.criterionId}: ${titleCase(criterion.result)} | tasks: ${list(criterion.taskIds, redactor)} | tests: ${list(criterion.testCaseIds, redactor)} | evidence: ${list(criterion.evidenceArtifactIds, redactor)} | comments: ${list(criterion.verifierComments, redactor)}`,
  );
  const riskLines =
    resolved.knownRisks.length === 0
      ? ['- None.']
      : resolved.knownRisks.map(({ detail }) => `- ${oneLine(detail, redactor)}`);

  return [
    `Release candidate: ${resolved.candidate.releaseId}`,
    `Commit: ${resolved.candidate.commitSha.slice(0, 7)}`,
    `Specification: v${String(resolved.candidate.specificationVersion)}`,
    `Support level: ${titleCase(resolved.candidate.supportLevel)}`,
    '',
    'Build',
    `- Production build: ${reportValue(gate('production_build'), redactor)}`,
    `- Type check: ${reportValue(gate('typecheck'), redactor)}`,
    `- Lint policy: ${reportValue(gate('lint'), redactor)}`,
    '',
    'Tests',
    `- Unit: ${reportValue(gate('unit_tests'), redactor)}`,
    `- Integration: ${reportValue(gate('integration_tests'), redactor)}`,
    `- Browser: ${reportValue(gate('browser_smoke'), redactor)}`,
    `- Browser acceptance: ${reportValue(gate('browser_acceptance'), redactor)}`,
    `- Accessibility critical routes: ${reportValue({ result: resolved.candidate.accessibilityResult }, redactor)}`,
    '',
    'Security',
    `- Secret scan: ${reportValue(gate('secret_scan'), redactor)}`,
    `- Critical dependency findings: ${reportValue(gate('dependency_scan'), redactor)}`,
    `- Authorization isolation tests: ${reportValue(gate('authorization_tests'), redactor)}`,
    '',
    'Database',
    `- Migration dry run: ${reportValue(migration, redactor)}`,
    `- Destructive operations: ${detailValue(migration.result, 'destructiveOperations', redactor)}`,
    `- Backward compatible with previous release: ${detailValue(migration.result, 'backwardCompatible', redactor)}`,
    '',
    'Preview',
    `- Development server: ${reportValue(gate('dev_server_start'), redactor)}`,
    `- Readiness: ${reportValue(preview, redactor)}`,
    `- Observability check: ${reportValue(gate('observability_check'), redactor)}`,
    `- Console errors: ${detailValue(preview.result, 'consoleErrorCount', redactor)}`,
    '',
    'Rollback',
    `- Previous deployment: ${detailValue(rollback.result, 'previousDeployment', redactor)}`,
    `- Application rollback: ${reportValue(rollback, redactor)}`,
    `- Database compatibility: ${detailValue(rollback.result, 'databaseCompatibility', redactor)}`,
    '',
    'Acceptance criteria',
    ...criteriaLines,
    '',
    'Known risks',
    ...riskLines,
    '',
    `Verifier decision: ${titleCase(resolved.decision)}`,
  ].join('\n');
}

const StoredEvidenceManifestSchema = z
  .object({ artifactId: idSchema('art') })
  .strict();

export interface EvidenceManifestArtifactStore {
  /** Implementations atomically persist immutable bytes and set the release artifact link. */
  storeImmutableAndLinkRelease(input: {
    readonly releaseId: string;
    readonly expectedCommitSha: string;
    readonly artifactType: 'release_evidence_manifest';
    readonly contentType: 'application/json';
    readonly body: Uint8Array;
  }): Promise<unknown>;
}

export interface PersistedEvidenceManifest {
  readonly artifactId: string;
  readonly manifest: EvidenceManifest;
  readonly report: string;
}

export async function persistEvidenceManifest(
  candidateValue: unknown,
  redactor: SecretRedactor,
  store: EvidenceManifestArtifactStore,
): Promise<PersistedEvidenceManifest> {
  const candidate = ReleaseEvidenceCandidateSchema.parse(candidateValue);
  const manifest = assembleEvidenceManifest(candidate, redactor);
  const report = renderEvidenceReport(candidate, redactor);
  const stored = StoredEvidenceManifestSchema.parse(
    await store.storeImmutableAndLinkRelease({
      releaseId: candidate.releaseId,
      expectedCommitSha: candidate.commitSha,
      artifactType: 'release_evidence_manifest',
      contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify(manifest)),
    }),
  );
  return { artifactId: stored.artifactId, manifest, report };
}
