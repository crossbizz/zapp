export {
  buildApp,
  type AppDeps,
  type AppInstance,
  type AuthDeps,
  type LimitDeps,
  type OrgDeps,
  type SecretsDeps,
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
  type RoleUpdate,
} from './orgs/store.js';
/** One pagination shape for every list endpoint (master plan §7). */
export type { PageRequest, StorePage } from './pagination.js';
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
  AUDIT_ACTOR_TYPES,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  AuditActionSchema,
  AuditActorSchema,
  AuditActorTypeSchema,
  AuditMetadataSchema,
  AuditRecordSchema,
  AuditScalarSchema,
  AuditTargetSchema,
  AuditTargetTypeSchema,
  AuditValueSchema,
  type AuditAction,
  type AuditActor,
  type AuditActorType,
  type AuditMetadata,
  type AuditRecord,
  type AuditScalar,
  type AuditTarget,
  type AuditTargetType,
  type AuditValue,
} from '@zapp/contracts';
export {
  AuditEntrySchema,
  createDbAuditSink,
  createInMemoryAuditSink,
  NO_TRANSACTION,
  type AuditEntry,
  type AuditExecutor,
  type AuditHook,
  type AuditSink,
} from './plugins/audit.js';
export { createRedisTokenDenylist } from './auth/denylist.js';
export { createRedisDeviceStore } from './auth/device.js';
export { createRedisConnection, type RedisCommands, type RedisConnection } from './redis/client.js';
export {
  loadRateLimitSettings,
  RATE_LIMIT_CLASSES,
  RATE_LIMITS_PATH,
  trustProxyOption,
  type ProxyTrust,
  type RateLimitClass,
  type RateLimitConfig,
  type RateLimitRule,
  type RateLimitSettings,
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
export { loadRedisUrl, loadRunIntentHmacKey } from './env.js';

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
// CP-6 — the project lifecycle. The git service is a port so the transaction
// that creates a project (project + repository + branch + environments + audit,
// or none of them) can be exercised against a fake that refuses; plan 06's
// GIT-2 binds the Forgejo implementation in `composeApp`.
export {
  createRecordOnlyGitService,
  GIT_CREATE_DEADLINE_MS,
  GitServiceError,
  type CreatedRepository,
  type CreateRepositoryInput,
  type GitServicePort,
} from './git/port.js';

// CP-7 — the secrets vault. Three seams leave this package:
//
//   - `MasterKeyPort`, so plan 09's KMS binding replaces `createEnvMasterKey`
//     without a caller changing.
//   - `ServiceTokenVerifier`, implemented by CP-8 below.
//   - `redactSecrets`, because PRD §18.12's redaction requirement belongs to
//     plans 03, 04 and 05 as much as to this one, and three implementations of
//     it is three chances to write a subtly wrong one.
//
// `decryptSecret` is deliberately *not* exported. The only decryption in the
// system happens behind the audited `SecretVault`, and a package export would be
// a second way to do it that writes no audit row.
export {
  KEY_BYTES,
  SecretDecryptionError,
  createEnvMasterKey,
  encryptSecret,
  type EnvMasterKeyConfig,
  type MasterKeyPort,
  type SecretEnvelope,
  type WrappedDataKey,
} from './secrets/crypto.js';
export {
  redactCredentials,
  redactSecrets,
  secretMarker,
  type SecretRegistry,
} from './secrets/redaction.js';
export {
  createSecretVault,
  type DecryptRequest,
  type DecryptedSecret,
  type SecretRead,
  type SecretVault,
  type SecretVaultDeps,
} from './secrets/vault.js';
export { loadMasterKey } from './env.js';

// CP-8 — service-to-service auth. The primitive itself lives in `@zapp/config`
// (`createServiceTokenSigner`), because a calling service needs to *sign* and
// only this one needs to verify; what is exported here is the gate around it,
// the header a caller sends on, and the audience the decrypt route demands —
// which together are everything plans 03 and 08 need to call `/internal/*`.
export {
  SERVICE_TOKEN_HEADER,
  createServiceTokenVerifier,
  serviceOf,
  serviceTokenKey,
  type RequireServiceOptions,
  type ServiceAuthRejection,
  type ServiceIdentity,
  type ServiceTokenExpectations,
  type ServiceTokenVerifier,
  type ServiceTokenVerifierDeps,
  type ServiceVerdict,
} from './internal/service-auth.js';
export { SECRET_DECRYPT_AUDIENCE, SECRET_DECRYPT_CALLERS } from './internal/secrets.js';
export { loadServiceTokenConfig } from './env.js';
export type {
  CreatedSecret,
  DeleteSecretInput,
  NewSecretInput,
  ReadSecretInput,
  RotateSecretInput,
  SecretListRequest,
  StoredSecret,
  TenantSecretRepository,
} from './tenant/db.js';
export {
  BRANCH_ACTIVE,
  DEFAULT_BRANCH,
  DEFAULT_ENVIRONMENTS,
  INTERNAL_PROVIDER,
  NO_SYNC,
  SOURCE_TYPES,
  type SourceType,
} from './tenant/vocabulary.js';
export type {
  ProjectListRequest,
  ProjectPatch,
  ProjectResources,
  RepositoryRequest,
  UpdatedProject,
  UpdateProjectInput,
} from './tenant/db.js';
