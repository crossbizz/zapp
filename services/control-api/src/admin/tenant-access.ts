import { idSchema } from '@zapp/contracts';

import type { TenantDatabase, TenantDbFactory } from '../tenant/db.js';

/**
 * The deliberately narrow cross-tenant capability used by audited staff support.
 * Public route modules receive this port, never the unscoped tenant factory.
 */
export interface SupportTenantAccessPort {
  forOrganization(organizationId: string): TenantDatabase;
}

export function createSupportTenantAccess(
  tenantDb: TenantDbFactory,
): SupportTenantAccessPort {
  return {
    forOrganization: (organizationId) => tenantDb(idSchema('org').parse(organizationId)),
  };
}
