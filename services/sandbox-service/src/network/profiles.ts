import { NetworkProfileSchema, type NetworkProfile } from '@zapp/contracts';
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
