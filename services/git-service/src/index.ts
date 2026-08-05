/**
 * What this service exports to the rest of the workspace.
 *
 * Deliberately small, and deliberately not the provider: nothing outside this
 * package should construct a Forgejo client, because doing so means holding the
 * admin token. Callers reach this service over HTTP with a service token
 * (`/internal/git/*`), and the *contract* they code against is
 * `@zapp/contracts`' `GitProvider`.
 *
 * What is here is what a test harness or a future in-process composition needs.
 */
export { buildApp, type AppDeps, type AppInstance } from './app.js';
export { GIT_AUDIT_ACTIONS, type GitAuditAction, type GitAuditEvent } from './audit.js';
export {
  BackupDateSchema,
  backupKey,
  createDbBackupInventory,
  createGitBundleCommands,
  createR2BackupObjectStore,
  createS3BackupObjectStore,
  enforceBackupRetention,
  latestBackupKey,
  RESTORE_CREDENTIAL_SAFETY_MARGIN_MS,
  RestoreRepositoryResultSchema,
  restoreRepositoryBackup,
  runNightlyBackups,
  runRepositoryBackup,
  selectRestoreDrillBackup,
  type BackupGit,
  type BackupInventory,
  type BackupObject,
  type BackupObjectStore,
  type BackupRepository,
  type ExpectedBranch,
  type NightlyBackupReport,
  type RepositoryBackupResult,
  type RestorePreparationGit,
  type RestoreRemoteGit,
  type RestoreRepositoryResult,
} from './backup.js';
export { composeApp, type ServiceComposition, type ServiceRuntime } from './compose.js';
export {
  ArtifactEnvSchema,
  loadArtifactEnv,
  loadDatabaseUrl,
  loadEnv,
  loadForgejoEnv,
  loadGitCommandDeadlineEnv,
  loadServiceTokenConfig,
  type ArtifactEnv,
  type ForgejoEnv,
  type GitCommandDeadlineEnv,
  type ServiceEnv,
} from './env.js';
export { GIT_SERVICE_AUDIENCE, SERVICE_TOKEN_HEADER } from './internal/service-auth.js';
export { GIT_CALLERS } from './routes.js';
export { DEFAULT_SWEEP_INTERVAL_MS, scheduleTokenSweep, type TokenSweep } from './sweep.js';
export {
  DEFAULT_TOKEN_TTL_SECONDS,
  MAX_TOKEN_TTL_SECONDS,
  TOKEN_ACCESS_LEVELS,
  type TokenAccess,
} from './tokens.js';
