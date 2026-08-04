import { z } from 'zod';
import { idSchema } from './ids.js';
import { EnvVarsSchema } from './sandbox.js';
import type { ProjectContext } from './project-adapter.js';

/** Exactly 40 lowercase hex characters: a resolved git commit, never a ref. */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'Invalid commit sha');

/**
 * Environments are outside the closed TypeID prefix list, so they carry the control
 * plane's own `environments` row identifier.
 */
export const EnvironmentIdSchema = z.string().min(1);

/** Provider-issued URL. https only: deployed traffic is never plaintext. */
const httpsUrlSchema = z.string().url().startsWith('https://', 'URL must use https');

/** PRD §27.1 `detectCompatibility` output; plan 07's registry ranks providers with it. */
export const CompatibilityResultSchema = z.object({
  providerId: z.string().min(1),
  compatible: z.boolean(),
  /** Why — the blockers when incompatible, the evidence when compatible. */
  reasons: z.array(z.string().min(1)),
});

export type CompatibilityResult = z.infer<typeof CompatibilityResultSchema>;

/**
 * What gets deployed. zapp builds in its own sandbox and hands the provider the
 * result: a directory of build output (plan 07 DEP-5) or a pushed image (DEP-4).
 */
export const DeploymentArtifactSchema = z.object({
  kind: z.enum(['directory', 'container_image']),
  /** Workspace-relative path for `directory`, registry reference for `container_image`. */
  reference: z.string().min(1),
});

export type DeploymentArtifact = z.infer<typeof DeploymentArtifactSchema>;

/** PRD §27.1 `createPreview` input — a provider-hosted preview, distinct from the sandbox preview. */
export const PreviewDeploymentInputSchema = z.object({
  projectId: idSchema('proj'),
  commitSha: CommitShaSchema,
  artifact: DeploymentArtifactSchema,
  env: EnvVarsSchema,
});

export type PreviewDeploymentInput = z.infer<typeof PreviewDeploymentInputSchema>;

/**
 * PRD §27.1 `deployProduction` input. The release id travels with it so provider
 * calls stay attributable to the immutable release record (plan 07 DEP-1).
 */
export const ProductionDeploymentInputSchema = z.object({
  projectId: idSchema('proj'),
  environmentId: EnvironmentIdSchema,
  releaseId: idSchema('rel'),
  commitSha: CommitShaSchema,
  artifact: DeploymentArtifactSchema,
  env: EnvVarsSchema,
});

export type ProductionDeploymentInput = z.infer<typeof ProductionDeploymentInputSchema>;

/** Where a deployment is, as the provider reports it. */
export const DeploymentStateSchema = z.enum([
  'queued',
  'building',
  'deploying',
  'ready',
  'failed',
  'cancelled',
]);

export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

/**
 * A deployment the provider has accepted. Provider identity stops here: the control
 * plane stores these ids on `deployments` rows and never on product models (PRD §27.2).
 */
export const DeploymentHandleSchema = z.object({
  providerId: z.string().min(1),
  providerDeploymentId: z.string().min(1),
  /** Absent until the provider has assigned a URL. */
  url: httpsUrlSchema.optional(),
  state: DeploymentStateSchema,
  createdAt: z.string().datetime(),
});

export type DeploymentHandle = z.infer<typeof DeploymentHandleSchema>;

/**
 * PRD §27.1 `getStatus` output. Richer than the workspace lifecycle enum because a
 * failed deployment must explain itself: plan 07 shows `detail` verbatim to the user.
 */
export const DeploymentStatusSchema = z.object({
  providerDeploymentId: z.string().min(1),
  state: DeploymentStateSchema,
  url: httpsUrlSchema.optional(),
  /** Provider-supplied explanation, secrets already scrubbed. */
  detail: z.string().optional(),
  updatedAt: z.string().datetime(),
});

export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;

/** One line of build or runtime output streamed from the provider. */
export const DeploymentLogSchema = z.object({
  at: z.string().datetime(),
  stream: z.enum(['stdout', 'stderr']),
  message: z.string(),
});

export type DeploymentLog = z.infer<typeof DeploymentLogSchema>;

/** PRD §27.1 `configureDomain` input; the user's custom hostname for one environment. */
export const DomainInputSchema = z.object({
  projectId: idSchema('proj'),
  environmentId: EnvironmentIdSchema,
  /** Apex or subdomain, without scheme: `app.example.com`. */
  hostname: z.string().min(1),
});

export type DomainInput = z.infer<typeof DomainInputSchema>;

/** A DNS record the user has to create before the hostname can verify (plan 07 DEP-10). */
export const DnsInstructionSchema = z.object({
  type: z.enum(['A', 'CNAME', 'TXT']),
  name: z.string().min(1),
  value: z.string().min(1),
});

export type DnsInstruction = z.infer<typeof DnsInstructionSchema>;

/**
 * PRD §27.1 `configureDomain` output. Verification is asynchronous: the caller polls
 * and shows the instructions until the provider reports `active`.
 */
export const DomainResultSchema = z.object({
  hostname: z.string().min(1),
  status: z.enum(['pending_dns', 'verifying', 'active', 'failed']),
  dnsInstructions: z.array(DnsInstructionSchema),
  /** User-readable cause when `failed` (wrong record, CAA, provider rate limit). */
  detail: z.string().optional(),
});

export type DomainResult = z.infer<typeof DomainResultSchema>;

/**
 * PRD §27.1 `rollback` input. The target deployment is explicit: choosing "the
 * previous healthy one" is the release service's decision, not the provider's (§27.5).
 */
export const RollbackInputSchema = z.object({
  projectId: idSchema('proj'),
  environmentId: EnvironmentIdSchema,
  toProviderDeploymentId: z.string().min(1),
  reason: z.string().min(1),
});

export type RollbackInput = z.infer<typeof RollbackInputSchema>;

/**
 * PRD §27.1, verbatim. Implemented per provider in plan 07 (Vercel, Fly.io); the
 * provider choice must not leak into product domain models (PRD §27.2).
 */
export interface DeploymentProvider {
  detectCompatibility(ctx: ProjectContext): Promise<CompatibilityResult>;
  createPreview(input: PreviewDeploymentInput): Promise<DeploymentHandle>;
  deployProduction(input: ProductionDeploymentInput): Promise<DeploymentHandle>;
  getStatus(id: string): Promise<DeploymentStatus>;
  streamLogs(id: string): AsyncIterable<DeploymentLog>;
  configureDomain(input: DomainInput): Promise<DomainResult>;
  rollback(input: RollbackInput): Promise<DeploymentHandle>;
}
