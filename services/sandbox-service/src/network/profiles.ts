import { NetworkProfileSchema, idSchema, type NetworkProfile } from '@zapp/contracts';
import { z } from 'zod';

const DomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine(
    (value) =>
      !value.includes('://') &&
      !value.includes('/') &&
      !value.includes(':') &&
      /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
        value,
      ),
    'Expected a hostname without a scheme, port, or path',
  );

const DEPENDENCY_DOMAINS = ['github.com', 'registry.npmjs.org'] as const;

export interface NetworkPolicy {
  readonly profile: NetworkProfile;
  readonly outboundDomains: readonly string[];
  readonly blockAll: boolean;
}

export const NetworkPolicyRecordSchema = z
  .object({
    operationKey: z.string().regex(/^op_[a-f0-9]{64}$/u),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    workspaceId: idSchema('ws'),
    policy: z
      .object({
        profile: NetworkProfileSchema,
        outboundDomains: z.array(DomainSchema),
        blockAll: z.boolean(),
      })
      .strict(),
    providerEnforced: z.boolean(),
    recordedAt: z.coerce.date(),
  })
  .strict();
export type NetworkPolicyRecord = z.infer<typeof NetworkPolicyRecordSchema>;

export interface NetworkPolicyRecorder {
  /** Implementations correlate or deduplicate retries by the stable operation key. */
  record(record: NetworkPolicyRecord): Promise<void>;
}

export function resolveNetworkPolicy(
  untrustedProfile: NetworkProfile,
  untrustedIntegrationDomains: readonly string[],
): NetworkPolicy {
  const profile = NetworkProfileSchema.parse(untrustedProfile);
  const integrations = z.array(DomainSchema).max(100).parse(untrustedIntegrationDomains);
  if (profile === 'restricted_verification') {
    return { profile, outboundDomains: [], blockAll: true };
  }
  const domains = profile === 'dependency_install' ? [...DEPENDENCY_DOMAINS, ...integrations] : integrations;
  return {
    profile,
    outboundDomains: [...new Set(domains)].sort(),
    blockAll: false,
  };
}
