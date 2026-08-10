import { SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import { z } from 'zod';

import {
  DiffRangeSchema,
  PolicyLocationSchema,
  PolicySignalSchema,
  policySignal,
  severityByLevel,
  type PolicySignal,
} from './placeholder.js';
import { detectIntroducedTodos } from './todo.js';
import { detectStructuralDuplicates } from './duplicate.js';
import { detectUnusedDependencies } from './unused-deps.js';
import { detectEmptyCatches } from './empty-catch.js';
import { detectDisabledTests } from './disabled-tests.js';
import { detectBroadRewrite } from './diff-size.js';
import { detectActivePrototypeMocks } from './mock-detect.js';
import { detectPlaceholderText } from './placeholder.js';

const MissingStateFindingSchema = z
  .object({
    missing: z.array(z.enum(['loading', 'empty', 'error'])).min(1).max(3),
    location: PolicyLocationSchema,
  })
  .strict();

const MissingCriticalStatesInputSchema = z
  .object({
    supportLevel: SupportLevelSchema,
    findings: z.array(MissingStateFindingSchema).max(2_000),
  })
  .strict();

const BroadRewriteContextSchema = z
  .object({
    changedLines: z.number().int().nonnegative().max(10_000_000),
    estimatedLines: z.number().int().positive().max(10_000_000),
    thresholdMultiplier: z.number().positive().max(100),
    locations: z.array(PolicyLocationSchema).min(1).max(2_000),
  })
  .strict();

const ActiveMockContextSchema = z
  .object({
    name: z.string().min(1).max(200),
    locations: z.array(PolicyLocationSchema).min(1).max(500),
  })
  .strict();

export const AntiSlopPolicyContextSchema = z
  .object({
    releaseCriticalPaths: z.array(z.string().min(1).max(4_096)).max(500).default([]),
    requiredFeatureRanges: z.array(DiffRangeSchema).max(2_000).default([]),
    introducedTestRanges: z.array(DiffRangeSchema).max(2_000).default([]),
    disabledTestWaivers: z.array(PolicyLocationSchema).max(2_000).default([]),
    broadRewrite: BroadRewriteContextSchema.nullable().default(null),
    activeMocks: z.array(ActiveMockContextSchema).max(500).default([]),
    missingStateFindings: z.array(MissingStateFindingSchema).max(2_000).default([]),
  })
  .strict();
export type AntiSlopPolicyContext = z.infer<typeof AntiSlopPolicyContextSchema>;

/**
 * Converts independently observed state gaps into a Minor policy signal. ADR-0017
 * deliberately keeps semantic source-code judgment outside this package.
 */
export function detectMissingCriticalStates(input: {
  readonly supportLevel: SupportLevel;
  readonly findings: readonly z.infer<typeof MissingStateFindingSchema>[];
}): PolicySignal[] {
  const parsed = MissingCriticalStatesInputSchema.parse(input);
  return policySignal(
    'states-check',
    severityByLevel(parsed.supportLevel, {
      compatible: 'warning',
      verified: 'warning',
      managed: 'warning',
    }),
    parsed.findings.map(({ location }) => location),
    false,
  );
}

export async function runAntiSlopPolicySuite(input: {
  readonly runtime: WorkspaceRuntime;
  readonly workspaceRoot: string;
  readonly supportLevel: SupportLevel;
  readonly context: unknown;
}): Promise<PolicySignal[]> {
  const supportLevel = SupportLevelSchema.parse(input.supportLevel);
  const context = AntiSlopPolicyContextSchema.parse(input.context);
  const toolSignals = await Promise.all([
    detectPlaceholderText({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
      releaseCriticalPaths: context.releaseCriticalPaths,
    }),
    detectIntroducedTodos({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
      requiredFeatureRanges: context.requiredFeatureRanges,
    }),
    detectStructuralDuplicates({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
    }),
    detectUnusedDependencies({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
    }),
    detectEmptyCatches({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
    }),
    detectDisabledTests({
      runtime: input.runtime,
      workspaceRoot: input.workspaceRoot,
      supportLevel,
      introducedTestRanges: context.introducedTestRanges,
      waivers: context.disabledTestWaivers,
    }),
  ]);
  const localSignals = [
    ...(context.broadRewrite === null
      ? []
      : detectBroadRewrite({ supportLevel, ...context.broadRewrite })),
    ...detectActivePrototypeMocks({ supportLevel, activeMocks: context.activeMocks }),
    ...detectMissingCriticalStates({
      supportLevel,
      findings: context.missingStateFindings,
    }),
  ];
  return z.array(PolicySignalSchema).max(9).parse([...toolSignals.flat(), ...localSignals]);
}
