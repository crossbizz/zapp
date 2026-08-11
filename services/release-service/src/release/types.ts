import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

export const DeploymentTypeSchema = z.enum([
  'first_deploy',
  'redeploy',
  'replace_deployment',
]);
export type DeploymentType = z.infer<typeof DeploymentTypeSchema>;

export const DataDispositionSchema = z.enum(['preserve', 'transfer', 'reset']);
export type DataDisposition = z.infer<typeof DataDispositionSchema>;

const RepositoryLineageIdSchema = z.string().trim().min(1).max(512);
const EnvironmentNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Z_][A-Z0-9_]*$/u);

export const DeploymentHistoryEntrySchema = z
  .object({
    environmentId: idSchema('env'),
    projectId: idSchema('proj'),
    repositoryLineageId: RepositoryLineageIdSchema,
    deployedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type DeploymentHistoryEntry = z.infer<typeof DeploymentHistoryEntrySchema>;

export const DeploymentTargetSchema = z
  .object({
    environmentId: idSchema('env'),
    projectId: idSchema('proj'),
    repositoryLineageId: RepositoryLineageIdSchema,
    explicitUserRetarget: z.boolean(),
  })
  .strict();
export type DeploymentTarget = z.infer<typeof DeploymentTargetSchema>;

export const DeploymentClassificationInputSchema = z
  .object({
    history: z.array(DeploymentHistoryEntrySchema).max(10_000),
    target: DeploymentTargetSchema,
  })
  .strict();
export type DeploymentClassificationInput = z.infer<typeof DeploymentClassificationInputSchema>;

/**
 * Classifies against the latest deployment in the target environment. Project ID and
 * repository lineage are structural identity signals; a user retarget is always explicit.
 */
export function classifyDeploymentType(inputValue: unknown): DeploymentType {
  const input = DeploymentClassificationInputSchema.parse(inputValue);
  const latest = input.history
    .filter(({ environmentId }) => environmentId === input.target.environmentId)
    .sort((left, right) => Date.parse(right.deployedAt) - Date.parse(left.deployedAt))[0];

  if (latest === undefined) return 'first_deploy';
  if (
    input.target.explicitUserRetarget ||
    latest.projectId !== input.target.projectId ||
    latest.repositoryLineageId !== input.target.repositoryLineageId
  ) {
    return 'replace_deployment';
  }
  return 'redeploy';
}

export const DeploymentConfirmationSchema = z
  .object({
    dataDisposition: DataDispositionSchema.nullable(),
  })
  .strict();
export type DeploymentConfirmation = z.infer<typeof DeploymentConfirmationSchema>;

export const DeploymentConfirmationValidationInputSchema = z
  .object({
    deploymentType: DeploymentTypeSchema,
    confirmation: DeploymentConfirmationSchema,
  })
  .strict();
export type DeploymentConfirmationValidationInput = z.infer<
  typeof DeploymentConfirmationValidationInputSchema
>;

export class DeploymentConfirmationError extends Error {
  constructor(
    readonly code: 'data_disposition_required' | 'data_disposition_not_applicable',
    readonly statusCode: 422,
    message: string,
  ) {
    super(message);
    this.name = 'DeploymentConfirmationError';
  }
}

/** Service-boundary validation mirrored by the versioned control API. */
export function validateDeploymentConfirmation(
  inputValue: unknown,
): DeploymentConfirmationValidationInput {
  const input = DeploymentConfirmationValidationInputSchema.parse(inputValue);
  if (
    input.deploymentType === 'replace_deployment' &&
    input.confirmation.dataDisposition === null
  ) {
    throw new DeploymentConfirmationError(
      'data_disposition_required',
      422,
      'Replacing a deployment requires a data disposition.',
    );
  }
  if (
    input.deploymentType !== 'replace_deployment' &&
    input.confirmation.dataDisposition !== null
  ) {
    throw new DeploymentConfirmationError(
      'data_disposition_not_applicable',
      422,
      'Data disposition only applies when replacing a deployment.',
    );
  }
  return input;
}

const SecretChangesSchema = z
  .object({
    addedNames: z.array(EnvironmentNameSchema).max(1_000),
    changedNames: z.array(EnvironmentNameSchema).max(1_000),
    removedNames: z.array(EnvironmentNameSchema).max(1_000),
  })
  .strict()
  .superRefine((changes, context) => {
    const allNames = [...changes.addedNames, ...changes.changedNames, ...changes.removedNames];
    if (new Set(allNames).size !== allNames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'secret_change_names_must_be_unique',
      });
    }
  });

export const DeploymentConfirmationSummaryInputSchema = z
  .object({
    deploymentType: DeploymentTypeSchema,
    dataDisposition: DataDispositionSchema.nullable(),
    migration: z
      .object({
        count: z.number().int().nonnegative().max(10_000),
        reversibility: z.enum(['reversible', 'compensating', 'unavailable']),
      })
      .strict(),
    secretChanges: SecretChangesSchema,
    urlEffect: z.enum(['created', 'preserved', 'changed']),
    activeUserEffect: z.enum(['brief_interruption', 'zero_downtime']),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.deploymentType !== 'replace_deployment' && input.dataDisposition !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'data_disposition_only_applies_to_replace_deployment',
        path: ['dataDisposition'],
      });
    }
  });
export type DeploymentConfirmationSummaryInput = z.infer<
  typeof DeploymentConfirmationSummaryInputSchema
>;

export const DeploymentConfirmationSummarySchema = z
  .object({
    deploymentType: DeploymentTypeSchema,
    title: z.enum(['First deploy', 'Redeploy', 'Replace deployment']),
    requiresExplicitDataDisposition: z.boolean(),
    effects: z
      .object({
        productionData: z.string().trim().min(1).max(2_000),
        secrets: z.string().trim().min(1).max(10_000),
        url: z.string().trim().min(1).max(2_000),
        activeUsers: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  })
  .strict();
export type DeploymentConfirmationSummary = z.infer<typeof DeploymentConfirmationSummarySchema>;

const TITLES: Readonly<Record<DeploymentType, DeploymentConfirmationSummary['title']>> = {
  first_deploy: 'First deploy',
  redeploy: 'Redeploy',
  replace_deployment: 'Replace deployment',
};

const URL_EFFECTS: Readonly<
  Record<DeploymentConfirmationSummaryInput['urlEffect'], string>
> = {
  created: 'Production URL: a new permanent URL will be created.',
  preserved: 'Production URL: preserved.',
  changed: 'Production URL: changed.',
};

const ACTIVE_USER_EFFECTS: Readonly<
  Record<DeploymentConfirmationSummaryInput['activeUserEffect'], string>
> = {
  zero_downtime:
    'Active users: zero downtime. Traffic switches only after health checks pass.',
  brief_interruption:
    'Active users: a brief interruption is expected while the provider switches traffic.',
};

function migrationEffect(
  input: DeploymentConfirmationSummaryInput,
): string {
  if (input.deploymentType === 'replace_deployment' && input.dataDisposition === null) {
    return 'Production data: select Preserve, Transfer, or Reset. No choice will be inferred.';
  }
  if (input.dataDisposition === 'reset') {
    return 'Production data: reset. This destructive choice requires explicit selection.';
  }
  if (input.migration.count === 0) {
    if (input.dataDisposition === 'transfer') {
      return 'Production data: transferred to the replacement deployment. No migrations will run.';
    }
    return 'Production data: preserved. No migrations will run.';
  }
  const noun = input.migration.count === 1 ? 'migration' : 'migrations';
  const count = String(input.migration.count);
  if (input.dataDisposition === 'transfer') {
    return `Production data: migrated to the replacement deployment by ${count} ${noun}. Reversibility: ${input.migration.reversibility}.`;
  }
  if (input.dataDisposition === 'preserve') {
    return `Production data: preserved and migrated in place by ${count} ${noun}. Reversibility: ${input.migration.reversibility}.`;
  }
  return `Production data: migrated by ${count} ${noun}. Reversibility: ${input.migration.reversibility}.`;
}

function list(names: readonly string[]): string {
  return names.length === 0 ? 'none' : [...names].sort().join(', ');
}

function secretEffect(input: DeploymentConfirmationSummaryInput['secretChanges']): string {
  return `Secrets: added ${list(input.addedNames)}; changed ${list(input.changedNames)}; removed ${list(input.removedNames)}.`;
}

/** Stable user-language payload consumed verbatim by WEB-14. */
export function createDeploymentConfirmationSummary(
  inputValue: unknown,
): DeploymentConfirmationSummary {
  const input = DeploymentConfirmationSummaryInputSchema.parse(inputValue);
  return DeploymentConfirmationSummarySchema.parse({
    deploymentType: input.deploymentType,
    title: TITLES[input.deploymentType],
    requiresExplicitDataDisposition: input.deploymentType === 'replace_deployment',
    effects: {
      productionData: migrationEffect(input),
      secrets: secretEffect(input.secretChanges),
      url: URL_EFFECTS[input.urlEffect],
      activeUsers: ACTIVE_USER_EFFECTS[input.activeUserEffect],
    },
  });
}
