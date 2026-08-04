export { buildApp, type AppDeps, type AppInstance, type AuthDeps, type OrgDeps } from './app.js';
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
  ROLES,
  can,
  type Action,
  type PermissionContext,
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
} from './orgs/store.js';
export {
  createInMemoryInviteStore,
  hashInviteToken,
  INVITE_TTL_MS,
  type InviteClaim,
  type InviteRecord,
  type InviteStore,
} from './orgs/invites.js';
export {
  AUDIT_ACTIONS,
  createInMemoryAuditSink,
  type AuditAction,
  type AuditRecord,
  type AuditSink,
} from './plugins/audit.js';
