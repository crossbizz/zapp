export {
  buildApp,
  type AppDeps,
  type AppInstance,
  type AuthDeps,
  type LimitDeps,
  type OrgDeps,
  type TenantDeps,
} from './app.js';
export { ApiError } from './errors.js';
export { REQUEST_ID_HEADER } from './plugins/context.js';

// CP-2 — identity. The port and its fake are exported so later tasks (CP-3's
// organization creation, the generated SDK's tests) build on the same seam.
export {
  AuthPortError,
  type AuthIdentity,
  type AuthPort,
  type AuthPortErrorCode,
} from './auth/port.js';
export { createStytchAuthPort, type StytchAuthPortConfig } from './auth/stytch.js';
export { loadAuthEnv, type AuthConfig, type AuthEnv } from './auth/config.js';
export { createDbUserStore, type UserProfile, type UserStore } from './auth/users.js';
export { createInMemoryTokenDenylist, type TokenDenylist } from './auth/denylist.js';
export { createInMemoryDeviceStore, type DeviceStore } from './auth/device.js';
export { CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE, SESSION_COOKIE } from './auth/cookies.js';
export type { SessionContext } from './plugins/auth.js';

// CP-3 — organizations, memberships and the PRD §22.2 matrix. `can` is the only
// authorization primitive in this service; later tasks call it rather than
// comparing roles.
export {
  ACTIONS,
  PERMISSION_SETTINGS,
  ROLES,
  can,
  type Action,
  type PermissionContext,
  type PermissionSetting,
  type Role,
} from './policy/permissions.js';
export {
  createDbOrganizationStore,
  SlugTakenError,
  type MemberUpdate,
  type MembershipRecord,
  type MembershipStatus,
  type OrganizationMembership,
  type OrganizationRecord,
  type OrganizationStore,
  type PageRequest,
  type RoleUpdate,
  type StorePage,
} from './orgs/store.js';
export {
  createInMemoryInviteStore,
  createRedisInviteStore,
  hashInviteToken,
  INVITE_TTL_MS,
  type ClaimInput,
  type InviteClaim,
  type InviteRecord,
  type InviteStore,
} from './orgs/invites.js';

// CP-5 — the audit trail, idempotency keys and rate limits. The sinks and
// stores are exported so a later service composes the same seams rather than
// inventing parallel ones; `composeApp` is what `server.ts` itself uses.
export {
  AUDIT_ACTIONS,
  createDbAuditSink,
  createInMemoryAuditSink,
  NO_TRANSACTION,
  type AuditAction,
  type AuditExecutor,
  type AuditHook,
  type AuditMetadata,
  type AuditRecord,
  type AuditSink,
  type AuditValue,
} from './plugins/audit.js';
export { createRedisTokenDenylist } from './auth/denylist.js';
export { createRedisDeviceStore } from './auth/device.js';
export { createRedisConnection, type RedisCommands, type RedisConnection } from './redis/client.js';
export {
  loadRateLimits,
  RATE_LIMIT_CLASSES,
  RATE_LIMITS_PATH,
  type RateLimitClass,
  type RateLimitConfig,
  type RateLimitRule,
} from './config/rate-limits.js';
export {
  createInMemoryRateLimiter,
  createRedisRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
} from './plugins/rate-limit.js';
export {
  createInMemoryIdempotencyStore,
  createRedisIdempotencyStore,
  IDEMPOTENT_REPLAY_HEADER,
  type IdempotencyEntry,
  type IdempotencyStore,
  type StoredResponse,
} from './plugins/idempotency.js';
export { composeApp, type ServiceRuntime } from './compose.js';
export { loadRedisUrl } from './env.js';

// CP-4 — tenant context. `forOrg` never leaves this boundary: a caller builds
// the factory once and hands it to `buildApp`, and every route reads through
// the organization-bound handle the plugin puts on the request.
export {
  ORGANIZATION_HEADER,
  authorize,
  selectOrganizationId,
  tenantOf,
  type MembershipLookup,
  type TenantContext,
} from './plugins/tenant.js';
export {
  createTenantDbFactory,
  type CreatedProject,
  type NewProjectInput,
  type TenantDatabase,
  type TenantDbFactory,
} from './tenant/db.js';
