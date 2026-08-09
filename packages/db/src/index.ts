export { createDb, type Database, type Db, type Executor, type Transaction } from './client.js';
export { nextEventSequence } from './events.js';
export {
  forOrg,
  type EventRange,
  type EventRepository,
  type ProjectRepository,
  type PreviewShareRepository,
  type RunRepository,
  type TenantDb,
} from './tenant.js';

// PRD §23.1 — identity and billing.
export {
  memberships,
  organizations,
  users,
  type Membership,
  type NewMembership,
  type NewOrganization,
  type NewUser,
  type Organization,
  type User,
} from './schema/identity.js';
export {
  USAGE_CATEGORIES,
  accountingLeaderLeases,
  modelCompletionJournal,
  runCreditAccounts,
  runCreditCeilingAdjustments,
  subscriptions,
  usageLedger,
  usageOutbox,
  type AccountingLeaderLease,
  type ModelCompletionJournal,
  type NewSubscription,
  type NewUsageLedgerEntry,
  type RunCreditAccount,
  type RunCreditCeilingAdjustment,
  type Subscription,
  type UsageOutboxEntry,
  type UsageCategory,
  type UsageLedgerEntry,
} from './schema/billing.js';

// PRD §23.2 — project state.
export {
  branches,
  environments,
  projectContracts,
  previewShares,
  projects,
  repositories,
  type Branch,
  type Environment,
  type NewBranch,
  type NewEnvironment,
  type NewProject,
  type NewProjectContract,
  type NewRepository,
  type Project,
  type ProjectContract,
  type PreviewShareRow,
  type NewPreviewShareRow,
  type Repository,
} from './schema/projects.js';

// PRD §23.3 — specification and planning.
export {
  agentPhases,
  agentRuns,
  agentTasks,
  approvals,
  decisions,
  specifications,
  type AgentPhase,
  type AgentRun,
  type AgentTask,
  type Approval,
  type Decision,
  type NewAgentPhase,
  type NewAgentRun,
  type NewAgentTask,
  type NewApproval,
  type NewDecision,
  type NewSpecification,
  type Specification,
} from './schema/planning.js';

// PRD §23.4 — execution and evidence.
export {
  MAX_EVENT_PAYLOAD_BYTES,
  agentEvents,
  artifacts,
  runEventCounters,
  testCases,
  testRuns,
  verificationResults,
  workspaces,
  type AgentEventRow,
  type Artifact,
  type NewAgentEventRow,
  type NewArtifact,
  type NewTestCase,
  type NewTestRun,
  type NewVerificationResult,
  type NewWorkspace,
  type RunEventCounter,
  type TestCase,
  type TestRun,
  type VerificationResult,
  type Workspace,
} from './schema/execution.js';

// PRD §23.5 — release state.
export {
  deployments,
  releases,
  syntheticChecks,
  type Deployment,
  type NewDeployment,
  type NewRelease,
  type NewSyntheticCheck,
  type Release,
  type SyntheticCheck,
} from './schema/releases.js';

// PRD §23.6 — security and integrations.
export {
  auditEvents,
  integrationConnections,
  secretCiphertexts,
  secretMetadata,
  type AuditEvent,
  type IntegrationConnection,
  type NewAuditEvent,
  type NewIntegrationConnection,
  type NewSecretCiphertext,
  type NewSecretMetadata,
  type SecretCiphertext,
  type SecretMetadata,
} from './schema/security.js';
