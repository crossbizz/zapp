import { createHash } from 'node:crypto';

/** The same self-service organization identity is used at Stytch and in zapp. */
export interface DefaultOrganizationIdentity {
  readonly email: string;
  readonly displayName?: string;
}

export interface DefaultOrganization {
  readonly name: string;
  readonly slug: string;
}

const ORGANIZATION_SUFFIX = "'s Workspace";

function userPrefix(identity: DefaultOrganizationIdentity): string {
  const displayName = identity.displayName?.trim();
  if (displayName !== undefined && displayName !== '' && displayName !== identity.email) {
    return displayName.slice(0, 96);
  }

  const localPart = identity.email.trim().split('@', 1)[0]?.trim();
  return localPart === undefined || localPart === '' ? 'User' : localPart.slice(0, 96);
}

/**
 * Names the personal workspace without exposing a raw email address in its slug.
 * The email digest makes independently generated Stytch and database slugs agree
 * while keeping two people with the same display name collision-safe.
 */
export function defaultOrganizationForIdentity(
  identity: DefaultOrganizationIdentity,
): DefaultOrganization {
  const prefix = userPrefix(identity);
  const slugBase = prefix
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'user';
  const digest = createHash('sha256')
    .update(identity.email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 12);

  return {
    name: `${prefix}${ORGANIZATION_SUFFIX}`,
    slug: `${slugBase}-workspace-${digest}`,
  };
}
