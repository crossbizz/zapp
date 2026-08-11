import { z } from 'zod';

import { CriterionIdSchema, CriterionRecordSchema } from '../criteria.js';
import { GateResultSchema } from '../gates/registry.js';
import {
  GateIdSchema,
  GateRequirementClassSchema,
  GateWaiverSchema,
} from '../policy-matrix.js';
import {
  PolicySignalIdSchema,
  PolicySignalSchema,
} from '../anti-slop/placeholder.js';

export const VerificationDecisionSchema = z.enum(['approved', 'rejected', 'needs_human']);
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

export const VerificationRiskSchema = z
  .object({
    code: z.enum([
      'gate_failed',
      'gate_evidence_missing',
      'required_gate_not_applicable',
      'criterion_failed',
      'critical_criterion_unverified',
      'criterion_unverified',
      'criterion_waived',
      'policy_signal',
    ]),
    severity: z.enum(['blocking', 'human_review', 'warning']),
    gateId: GateIdSchema.optional(),
    criterionId: CriterionIdSchema.optional(),
    policySignalId: PolicySignalIdSchema.optional(),
    policySignal: PolicySignalSchema.optional(),
    summary: z.string().min(1).max(1_024),
  })
  .strict();
export type VerificationRisk = z.infer<typeof VerificationRiskSchema>;

export const GateEvaluationSchema = z
  .object({
    gateId: GateIdSchema,
    class: GateRequirementClassSchema,
    result: GateResultSchema,
    waiver: GateWaiverSchema.optional(),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (evaluation.result.status === 'waived') {
      if (
        evaluation.class !== 'required_or_explicit_waiver' ||
        evaluation.waiver?.gateId !== evaluation.gateId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'verifier_unauthorized_gate_waiver',
        });
      }
    } else if (evaluation.waiver !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verifier_unapplied_gate_waiver',
      });
    }
  });
export type GateEvaluation = z.infer<typeof GateEvaluationSchema>;

export const VerifierDecisionInputSchema = z
  .object({
    gateEvaluations: z.array(GateEvaluationSchema).max(100),
    criteria: z.array(CriterionRecordSchema).min(1).max(1_000),
    criticalCriterionIds: z.array(CriterionIdSchema).max(1_000),
    policySignals: z.array(PolicySignalSchema).max(9).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const gateIds = input.gateEvaluations.map(({ gateId }) => gateId);
    if (new Set(gateIds).size !== gateIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'verifier_duplicate_gate' });
    }
    const criterionIds = input.criteria.map(({ criterionId }) => criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'verifier_duplicate_criterion' });
    }
    if (new Set(input.criticalCriterionIds).size !== input.criticalCriterionIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'verifier_duplicate_critical_criterion' });
    }
    const knownCriteria = new Set(criterionIds);
    for (const criterionId of input.criticalCriterionIds) {
      if (!knownCriteria.has(criterionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `verifier_critical_criterion_missing:${criterionId}`,
        });
      }
    }
  });

export const VerifierDecisionResultSchema = z
  .object({
    decision: VerificationDecisionSchema,
    criteriaResults: z.array(CriterionRecordSchema).min(1),
    risks: z.array(VerificationRiskSchema),
  })
  .strict();
export type VerifierDecisionResult = z.infer<typeof VerifierDecisionResultSchema>;

const STRICT_APPLICABILITY_CLASSES = new Set<z.infer<typeof GateRequirementClassSchema>>([
  'required',
  'required_or_explicit_waiver',
  'required_policy',
  'required_for_critical_logic',
  'required_for_managed_integrations',
  'required_for_managed_auth',
  'required_for_code',
  'required_for_supported_release_state',
]);

const NON_BLOCKING_FAILURE_CLASSES = new Set<z.infer<typeof GateRequirementClassSchema>>([
  'best_effort',
  'advisory',
]);

function gateFailureSeverity(
  requirementClass: z.infer<typeof GateRequirementClassSchema>,
): 'blocking' | 'warning' {
  return NON_BLOCKING_FAILURE_CLASSES.has(requirementClass) ? 'warning' : 'blocking';
}

export function decideVerification(inputValue: unknown): VerifierDecisionResult {
  const input = VerifierDecisionInputSchema.parse(inputValue);
  const criticalCriteria = new Set(input.criticalCriterionIds);
  const risks: VerificationRisk[] = [];

  for (const evaluation of input.gateEvaluations) {
    if (
      evaluation.result.status === 'passed' &&
      evaluation.result.evidenceArtifactIds.length === 0
    ) {
      const severity = gateFailureSeverity(evaluation.class);
      risks.push(
        VerificationRiskSchema.parse({
          code: 'gate_evidence_missing',
          severity,
          gateId: evaluation.gateId,
          summary: `${evaluation.gateId} reported success without an evidence artifact.`,
        }),
      );
    } else if (evaluation.result.status === 'failed') {
      const severity = gateFailureSeverity(evaluation.class);
      risks.push(
        VerificationRiskSchema.parse({
          code: 'gate_failed',
          severity,
          gateId: evaluation.gateId,
          summary: `${evaluation.gateId} returned a failed result.`,
        }),
      );
    } else if (
      evaluation.result.status === 'not_applicable' &&
      STRICT_APPLICABILITY_CLASSES.has(evaluation.class)
    ) {
      risks.push(
        VerificationRiskSchema.parse({
          code: 'required_gate_not_applicable',
          severity: 'blocking',
          gateId: evaluation.gateId,
          summary: `${evaluation.gateId} is required but returned not applicable.`,
        }),
      );
    }
  }

  for (const criterion of input.criteria) {
    if (criterion.result === 'failed') {
      risks.push(
        VerificationRiskSchema.parse({
          code: 'criterion_failed',
          severity: 'blocking',
          criterionId: criterion.criterionId,
          summary: `${criterion.criterionId} failed independent verification.`,
        }),
      );
    } else if (criterion.result === 'unverified') {
      const critical = criticalCriteria.has(criterion.criterionId);
      risks.push(
        VerificationRiskSchema.parse({
          code: critical ? 'critical_criterion_unverified' : 'criterion_unverified',
          severity: critical ? 'blocking' : 'human_review',
          criterionId: criterion.criterionId,
          summary: critical
            ? `${criterion.criterionId} is a critical-flow criterion without passing evidence.`
            : `${criterion.criterionId} has no conclusive verification evidence.`,
        }),
      );
    } else if (criterion.result === 'waived') {
      risks.push(
        VerificationRiskSchema.parse({
          code: 'criterion_waived',
          severity: 'warning',
          criterionId: criterion.criterionId,
          summary: `${criterion.criterionId} was explicitly waived.`,
        }),
      );
    }
  }

  for (const policySignal of input.policySignals) {
    risks.push(
      VerificationRiskSchema.parse({
        code: 'policy_signal',
        severity: policySignal.severity,
        policySignalId: policySignal.id,
        policySignal,
        summary: `${policySignal.id} reported ${String(policySignal.locations.length)} location(s).`,
      }),
    );
  }

  const decision = risks.some(({ severity }) => severity === 'blocking')
    ? 'rejected'
    : risks.some(({ severity }) => severity === 'human_review')
      ? 'needs_human'
      : 'approved';
  return VerifierDecisionResultSchema.parse({
    decision,
    criteriaResults: input.criteria,
    risks,
  });
}
