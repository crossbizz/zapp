import { z } from 'zod';

export const GitHubAuthorizationBindingSchema = z
  .object({
    organizationId: z.string().min(1),
    actorId: z.string().min(1),
  })
  .strict();

export const GitHubAuthorizeResponseSchema = z.object({ url: z.string().url() }).strict();

export const GitHubRepositorySchema = z
  .object({
    id: z.string().min(1),
    fullName: z.string().min(1),
    private: z.boolean(),
    defaultBranch: z.string().min(1),
  })
  .strict();

export const GitHubBranchSchema = z
  .object({
    name: z.string().min(1),
    headCommitSha: z.string().min(1),
  })
  .strict();

export const GitHubRepositoryPageSchema = z
  .object({ items: z.array(GitHubRepositorySchema), nextCursor: z.string().nullable() })
  .strict();

export const GitHubBranchPageSchema = z
  .object({ items: z.array(GitHubBranchSchema), nextCursor: z.string().nullable() })
  .strict();

export const GitHubCompleteInstallationInputSchema = z
  .object({ installationId: z.string().trim().min(1), code: z.string().min(1) })
  .strict();

export const GitHubInstallationSchema = z.object({ installationId: z.string().min(1) }).strict();

export const GitHubRepositoryListInputSchema = z
  .object({ installationId: z.string().trim().min(1), cursor: z.string().min(1).optional() })
  .strict();

export const GitHubBranchListInputSchema = z
  .object({
    installationId: z.string().trim().min(1),
    repositoryId: z.string().trim().min(1),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const GitHubProviderFailureSchema = z.enum(['not_found', 'unavailable']);

export const GitHubProviderConfigSchema = z
  .object({
    appId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
    privateKey: z.string().min(1),
    baseUrl: z.string().url().optional(),
  })
  .strict();

export const GitHubDiscoveryQuerySchema = z
  .object({
    installationId: z.string().trim().min(1).max(200),
    cursor: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const GitHubRepositoryParamsSchema = z
  .object({ repositoryId: z.string().trim().min(1).max(200) })
  .strict();

export const GitHubWebhookHeadersSchema = z
  .object({
    'x-github-delivery': z.string().trim().min(1).max(200),
    'x-github-event': z.string().trim().min(1).max(100),
    'x-hub-signature-256': z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

export const GitHubWebhookPayloadSchema = z.record(z.unknown());
export const GitHubWebhookEventNameSchema = z.enum(['push', 'pull_request', 'installation']);

export const GitHubWebhookReceiptSchema = z
  .object({
    deliveryId: z.string().min(1),
    eventName: GitHubWebhookEventNameSchema,
    payload: GitHubWebhookPayloadSchema,
    receivedAt: z.date(),
  })
  .strict();

export const GitHubWebhookQueueMessageSchema = z
  .object({
    deliveryId: z.string().min(1),
    eventName: GitHubWebhookEventNameSchema,
    installationId: z.string().min(1).optional(),
    payload: GitHubWebhookPayloadSchema,
  })
  .strict();

export type GitHubAuthorizationBinding = z.infer<typeof GitHubAuthorizationBindingSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
export type GitHubBranch = z.infer<typeof GitHubBranchSchema>;
export type GitHubCompleteInstallationInput = z.infer<typeof GitHubCompleteInstallationInputSchema>;
export type GitHubInstallation = z.infer<typeof GitHubInstallationSchema>;
export type GitHubRepositoryListInput = z.infer<typeof GitHubRepositoryListInputSchema>;
export type GitHubBranchListInput = z.infer<typeof GitHubBranchListInputSchema>;
export type GitHubRepositoryPage = z.infer<typeof GitHubRepositoryPageSchema>;
export type GitHubBranchPage = z.infer<typeof GitHubBranchPageSchema>;
export type GitHubProviderFailure = z.infer<typeof GitHubProviderFailureSchema>;
export type GitHubProviderConfig = z.infer<typeof GitHubProviderConfigSchema>;
export type GitHubWebhookEventName = z.infer<typeof GitHubWebhookEventNameSchema>;
export type GitHubWebhookReceipt = z.infer<typeof GitHubWebhookReceiptSchema>;
export type GitHubWebhookQueueMessage = z.infer<typeof GitHubWebhookQueueMessageSchema>;
