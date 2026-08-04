import { z } from 'zod';
import { idSchema } from './ids.js';
import { EnvVarsSchema, HttpsUrlSchema } from './primitives.js';

/**
 * PRD §18.9, in order. Both the membership and the order are contractual: plan 03's
 * lifecycle manager (WS-6) derives its legal-transition table from this list.
 */
export const WorkspaceStatusSchema = z.enum([
  'requested',
  'provisioning',
  'started',
  'ready',
  'active',
  'checkpointing',
  'idle',
  'terminated',
]);

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/** What the workspace was created for. Drives idle timeouts and image choice (plan 03 WS-6). */
export const WorkspacePurposeSchema = z.enum(['builder', 'verifier', 'preview', 'scan']);

export type WorkspacePurpose = z.infer<typeof WorkspacePurposeSchema>;

/** PRD §18.10 profile names. Sizes live in `RESOURCE_PROFILES`. */
export const ResourceProfileSchema = z.enum(['small', 'standard', 'large']);

export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;

/** One row of the PRD §18.10 table. Cores for CPU, GiB for memory. */
export interface ResourceProfileSpec {
  readonly cpuRequest: number;
  readonly cpuLimit: number;
  readonly memRequestGiB: number;
  readonly memLimitGiB: number;
}

/**
 * PRD §18.10 verbatim. Requested values are also the billing floor — Modal charges
 * on max(requested, observed) — so plan 03's cost recorder (WS-8) reads them here.
 */
export const RESOURCE_PROFILES = {
  small: { cpuRequest: 0.5, cpuLimit: 2, memRequestGiB: 1, memLimitGiB: 4 },
  standard: { cpuRequest: 1, cpuLimit: 4, memRequestGiB: 2, memLimitGiB: 8 },
  large: { cpuRequest: 2, cpuLimit: 8, memRequestGiB: 4, memLimitGiB: 16 },
} as const satisfies Record<ResourceProfile, ResourceProfileSpec>;

/**
 * PRD §18.11 egress profiles: registries and git hosts while installing, integrations
 * only while building and testing, deny-all (or a strict allowlist) for deterministic
 * verification.
 */
export const NetworkProfileSchema = z.enum([
  'dependency_install',
  'build_test',
  'restricted_verification',
]);

export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;

/**
 * PRD §18.2 `createWorkspace` input. Every identifier here also becomes a provider
 * tag (PRD §18.4) so an orphaned sandbox can be attributed and reaped (plan 03 WS-6).
 */
export const CreateWorkspaceInputSchema = z.object({
  organizationId: idSchema('org'),
  projectId: idSchema('proj'),
  // Branches are outside the closed TypeID prefix list, so they carry the git-side
  // identifier rather than a `br_` id.
  branchId: z.string().min(1),
  runId: idSchema('run').optional(),
  taskId: idSchema('task').optional(),
  purpose: WorkspacePurposeSchema,
  resourceProfile: ResourceProfileSchema,
  /** Immutable image tag from `infra/modal/images.lock.json` — never `latest` (plan 03 WS-2). */
  imageTag: z.string().min(1),
  env: EnvVarsSchema,
  networkProfile: NetworkProfileSchema,
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

/**
 * A live workspace as the provider sees it. Carries no `ws_` id: the provider is
 * addressed by its own opaque id, and the control plane joins the two (plan 03 WS-4).
 */
export const WorkspaceHandleSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  status: WorkspaceStatusSchema,
  resourceProfile: ResourceProfileSchema,
  imageTag: z.string().min(1),
  createdAt: z.string().datetime(),
  /** Provider-enforced termination deadline; plan 03's reaper replaces the sandbox before it (PRD §18.9). */
  expiresAt: z.string().datetime(),
});

export type WorkspaceHandle = z.infer<typeof WorkspaceHandleSchema>;

/** PRD §18.2 `exec` input: one command, one workspace, one deadline. */
export const ExecInputSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  /** Relative to the workspace root; escapes are rejected by the provider (PRD §16.3). */
  cwd: z.string().optional(),
  env: EnvVarsSchema.optional(),
  timeoutMs: z.number().int().positive(),
  /** True when the command needs a tty (interactive installers, colored output). */
  pty: z.boolean().optional(),
});

export type ExecInput = z.infer<typeof ExecInputSchema>;

/**
 * A started command. Output streaming, exit status and cancellation are addressed
 * by `execId` through plan 03's sandbox-service — the PRD §18.2 method set stops here.
 */
export const ExecHandleSchema = z.object({
  execId: z.string().min(1),
  providerWorkspaceId: z.string().min(1),
  startedAt: z.string().datetime(),
});

export type ExecHandle = z.infer<typeof ExecHandleSchema>;

/** PRD §18.8 retention classes: 30 days for active work and release evidence, 7 for diagnostics. */
export const CheckpointKindSchema = z.enum(['active', 'diagnostic', 'release_evidence']);

export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

/**
 * PRD §18.2 `createCheckpoint` input. Project and branch travel with the request so
 * the provider can tag the snapshot for reaping and support diagnostics.
 */
export const CheckpointInputSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  projectId: idSchema('proj'),
  branchId: z.string().min(1),
  kind: CheckpointKindSchema,
});

export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;

/**
 * A provider snapshot that `restoreCheckpoint` can start from. Snapshots are an
 * acceleration only: when one is missing or expired, plan 03 (WS-7) restores from
 * internal git plus the encrypted patch artifact instead (PRD §18.8).
 */
export const CheckpointRefSchema = z.object({
  providerSnapshotId: z.string().min(1),
  projectId: idSchema('proj'),
  branchId: z.string().min(1),
  kind: CheckpointKindSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});

export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

/**
 * PRD §18.2 `createPreview` input. The port is the in-sandbox preview proxy's
 * (PRD §18.13), not the application's; the proxy forwards to the contract port.
 */
export const PreviewInputSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  ttlSeconds: z.number().int().positive(),
  /** Short metadata carried by the connect token (PRD §18.11). */
  userId: idSchema('user'),
  projectId: idSchema('proj'),
});

export type PreviewInput = z.infer<typeof PreviewInputSchema>;

/**
 * An authenticated preview session. The URL is a provider connect URL, never a raw
 * public tunnel; sharing goes through a share record with its own expiry (plan 03 WS-12).
 *
 * Carries no revocation identifier, because the PRD §18.2 method set has no revoke
 * call to use one with — see `docs/adr/0003-sandbox-file-io-and-preview-revocation.md`.
 */
export const PreviewHandleSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  url: HttpsUrlSchema,
  expiresAt: z.string().datetime(),
});

export type PreviewHandle = z.infer<typeof PreviewHandleSchema>;

/**
 * PRD §18.2 `updateNetworkPolicy` input: the profile plus any extra hosts the
 * project's configured integrations need. Applied where the provider supports it and
 * always recorded, because P0 treats egress control as defense in depth (PRD §18.11).
 */
export const NetworkPolicyInputSchema = z.object({
  providerWorkspaceId: z.string().min(1),
  profile: NetworkProfileSchema,
  /** Extra allowed hostnames beyond the profile's baseline; empty when the baseline suffices. */
  allowedDomains: z.array(z.string().min(1)),
});

export type NetworkPolicyInput = z.infer<typeof NetworkPolicyInputSchema>;

/**
 * PRD §18.2, verbatim. Only plan 03's `sandbox-service` implements it, and it is the
 * only place the Modal SDK may be imported (master plan Global Constraint 1).
 *
 * `readFile` and `writeFile` take no workspace id in the PRD: the implementation binds
 * them to the workspace it is currently attached to. Kept verbatim on purpose — the
 * workspace-scoped replacement lands with plan 03 WS-4, per
 * `docs/adr/0003-sandbox-file-io-and-preview-revocation.md`.
 */
export interface CloudSandboxProvider {
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle>;
  attachWorkspace(providerWorkspaceId: string): Promise<WorkspaceHandle>;
  terminateWorkspace(providerWorkspaceId: string): Promise<void>;
  exec(input: ExecInput): Promise<ExecHandle>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  createCheckpoint(input: CheckpointInput): Promise<CheckpointRef>;
  restoreCheckpoint(ref: CheckpointRef): Promise<WorkspaceHandle>;
  createPreview(input: PreviewInput): Promise<PreviewHandle>;
  updateNetworkPolicy(input: NetworkPolicyInput): Promise<void>;
  getStatus(providerWorkspaceId: string): Promise<WorkspaceStatus>;
}
