import { idSchema, SupportLevelSchema, type SupportLevel } from '@zapp/contracts';
import { z } from 'zod';

export const GATE_IDS = [
  'dev_server_start',
  'production_build',
  'typecheck',
  'lint',
  'unit_tests',
  'integration_tests',
  'browser_smoke',
  'browser_acceptance',
  'authorization_tests',
  'migration_validation',
  'secret_scan',
  'dependency_scan',
  'preview_health',
  'rollback_readiness',
  'observability_check',
] as const;

export const GateIdSchema = z.enum(GATE_IDS);
export type GateId = z.infer<typeof GateIdSchema>;

export const GateRequirementClassSchema = z.enum([
  'required',
  'best_effort',
  'if_available',
  'required_or_explicit_waiver',
  'project_policy',
  'existing_only',
  'required_for_critical_logic',
  'as_applicable',
  'required_for_managed_integrations',
  'optional',
  'if_applicable',
  'required_for_managed_auth',
  'no',
  'advisory',
  'required_policy',
  'required_for_code',
  'required_for_supported_release_state',
  'recommended',
]);
export type GateRequirementClass = z.infer<typeof GateRequirementClassSchema>;

export const GateWaiverSchema = z
  .object({
    gateId: GateIdSchema,
    actorId: idSchema('user'),
    reason: z.string().trim().min(1).max(2_000),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GateWaiver = z.infer<typeof GateWaiverSchema>;

export const ProjectPolicySchema = z.object({ waivers: z.array(GateWaiverSchema) }).strict();
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

const GateRequirementSchema = z.discriminatedUnion('disposition', [
  z
    .object({
      gateId: GateIdSchema,
      class: GateRequirementClassSchema,
      disposition: z.literal('run'),
    })
    .strict(),
  z
    .object({
      gateId: GateIdSchema,
      class: z.literal('required_or_explicit_waiver'),
      disposition: z.literal('waived'),
      waiver: GateWaiverSchema,
    })
    .strict(),
]);
export type GateRequirement = z.infer<typeof GateRequirementSchema>;

const MATRIX = {
  dev_server_start: ['required', 'required', 'required'],
  production_build: ['best_effort', 'required', 'required'],
  typecheck: ['if_available', 'required_or_explicit_waiver', 'required_or_explicit_waiver'],
  lint: ['if_available', 'project_policy', 'project_policy'],
  unit_tests: ['existing_only', 'required_for_critical_logic', 'required'],
  integration_tests: ['existing_only', 'as_applicable', 'required_for_managed_integrations'],
  browser_smoke: ['required', 'required', 'required'],
  browser_acceptance: ['optional', 'required', 'required'],
  authorization_tests: ['optional', 'if_applicable', 'required_for_managed_auth'],
  migration_validation: ['no', 'if_applicable', 'required'],
  secret_scan: ['required', 'required', 'required'],
  dependency_scan: ['advisory', 'required_policy', 'required_policy'],
  preview_health: ['required', 'required', 'required'],
  rollback_readiness: ['no', 'required_for_code', 'required_for_supported_release_state'],
  observability_check: ['no', 'recommended', 'required'],
} as const satisfies Record<GateId, readonly [GateRequirementClass, GateRequirementClass, GateRequirementClass]>;

function levelIndex(level: SupportLevel): 0 | 1 | 2 {
  switch (level) {
    case 'compatible':
      return 0;
    case 'verified':
      return 1;
    case 'managed':
      return 2;
  }
}

export function requiredGates(levelValue: unknown, policyValue: unknown): GateRequirement[] {
  const level = SupportLevelSchema.parse(levelValue);
  const policy = ProjectPolicySchema.parse(policyValue);
  const index = levelIndex(level);
  const waivers = new Map<GateId, GateWaiver>();
  for (const waiver of policy.waivers) {
    const requirement = MATRIX[waiver.gateId][index];
    if (requirement !== 'required_or_explicit_waiver') throw new Error('gate_not_waivable');
    if (waivers.has(waiver.gateId)) throw new Error('duplicate_gate_waiver');
    waivers.set(waiver.gateId, waiver);
  }

  return GATE_IDS.map((gateId) => {
    const requirement = MATRIX[gateId][index];
    const waiver = waivers.get(gateId);
    return GateRequirementSchema.parse(
      waiver === undefined
        ? { gateId, class: requirement, disposition: 'run' }
        : { gateId, class: requirement, disposition: 'waived', waiver },
    );
  });
}
