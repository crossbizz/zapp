import { newId } from '@zapp/contracts';
import { specificationContentEtag } from '@zapp/specification-engine';
import type {
  AgentEventRow,
  AgentPhase,
  AgentRun,
  AgentTask,
  Approval,
  Artifact,
  AuditEvent,
  Branch,
  Deployment,
  Environment,
  Project,
  ProjectContract,
  PreviewShareRow,
  Repository,
  Release,
  RunCreditAccount,
  RunCreditCeilingAdjustment,
  SecretMetadata,
  Specification,
  TestRun,
  VerificationResult,
  Workspace,
} from '@zapp/db';

import { NO_TRANSACTION } from '../../src/plugins/audit.js';
import type { StorePage } from '../../src/pagination.js';
import type { SecretEnvelope } from '../../src/secrets/crypto.js';
import {
  vaultRef,
  type CreatedProject,
  type CreatedSecret,
  type DeleteSecretInput,
  type NewProjectInput,
  type NewRunInput,
  type NewSecretInput,
  type ReadSecretInput,
  type RotateSecretInput,
  type SecretListRequest,
  type StoredSecret,
  type ApproveSpecificationInput,
  type NewSpecificationInput,
  type TenantDatabase,
  type TenantDbFactory,
  type UpdateSpecificationInput,
  type UpdateProjectInput,
  type UpdatedProject,
} from '../../src/tenant/db.js';
import {
  BRANCH_ACTIVE,
  DEFAULT_BRANCH,
  DEFAULT_ENVIRONMENTS,
  INTERNAL_PROVIDER,
  NO_SYNC,
} from '../../src/tenant/vocabulary.js';

/**
 * The tenant handle, in memory, for the route suites.
 *
 * It is a double for PostgreSQL, not for the isolation rules: every method here
 * filters by `organizationId` exactly as `forOrg` and `src/tenant/db.ts` do, so
 * a route that leaks across tenants leaks here too. What it cannot prove is that
 * the *SQL* is scoped — `test/integration/tenant-isolation.test.ts` is what does
 * that, against a real database, and it is the milestone gate.
 *
 * Two behaviours are modelled deliberately rather than approximated:
 *
 *   - **Creation is all-or-nothing.** Every row is built into locals and pushed
 *     into the store only after the repository callback and the audit hook have
 *     both returned. A callback that throws leaves nothing behind, which is what
 *     a rolled-back transaction looks like from the outside — and lets the route
 *     suite assert the rollback without a database.
 *   - **The slug is unique per organization.** Two tenants may both own
 *     `checkout`; the same tenant may not own it twice. A global check here
 *     would let a route pass this suite and then leak the existence of another
 *     tenant's project in production.
 */

/** Rows shared by every handle the factory hands out, as one database would be. */
export class InMemoryTenantData {
  readonly projects: Project[] = [];
  readonly repositories: Repository[] = [];
  readonly branches: Branch[] = [];
  readonly environments: Environment[] = [];
  readonly releases: Release[] = [];
  readonly deployments: Deployment[] = [];
  readonly contracts: ProjectContract[] = [];
  readonly specifications: Specification[] = [];
  /** Makes the concurrent-create test expose a MAX(version) race in this double. */
  yieldSpecificationCreates = false;
  readonly specificationLocks = new Map<string, Promise<void>>();
  readonly runCreateLocks = new Map<string, Promise<void>>();
  readonly capabilityScanLocks = new Map<string, Promise<void>>();
  /** Completed PATCH operation keys per tenant-scoped specification. */
  readonly specificationOperations = new Map<string, Set<string>>();
  readonly runs: AgentRun[] = [];
  readonly runAccounting = new Map<string, NewRunInput['accounting']>();
  readonly events: AgentEventRow[] = [];
  readonly phases: AgentPhase[] = [];
  readonly tasks: AgentTask[] = [];
  readonly approvals: Approval[] = [];
  readonly artifacts: Artifact[] = [];
  readonly testRuns: TestRun[] = [];
  readonly verificationResults: VerificationResult[] = [];
  readonly creditAccounts: RunCreditAccount[] = [];
  readonly creditCeilingAdjustments: RunCreditCeilingAdjustment[] = [];
  readonly auditEvents: AuditEvent[] = [];
  readonly workspaces: Workspace[] = [];
  readonly previewShares: PreviewShareRow[] = [];
  readonly operations = new Map<
    string,
    { readonly key: string; state: 'requested' | 'completed' | 'rejected' }
  >();
  readonly secrets: SecretMetadata[] = [];
  /**
   * The vault, as a second store keyed by secret id — modelling the *table*
   * split, not just the field split.
   *
   * That matters: the property under test is that a metadata read cannot reach
   * ciphertext, and a double that kept the envelope on the metadata object would
   * let a route return it by spreading the row. Here there is nothing to spread.
   */
  readonly ciphertexts = new Map<string, SecretEnvelope>();

  /** Every handle reads and writes the same rows — see the class comment. */
  readonly factory: TenantDbFactory = (organizationId: string): TenantDatabase =>
    handleFor(this, organizationId);

  /** Seeds a contract for a project, as plan 05's scan pipeline eventually will. */
  addContract(project: Project, contract: Partial<ProjectContract> = {}): ProjectContract {
    const row: ProjectContract = {
      id: newId('pc'),
      organizationId: project.organizationId,
      projectId: project.id,
      version: 1,
      detectedFramework: 'next',
      contractJson: { version: 1, package_manager: 'pnpm' },
      createdAt: new Date('2026-08-15T12:00:00.000Z'),
      ...contract,
    };
    this.contracts.push(row);
    return row;
  }
}

/**
 * The tenant predicate, and the only way a query in this file selects rows —
 * the in-memory equivalent of `organization_id = <the tenant>` in a WHERE
 * clause. A method that filtered by anything else would be a double that is
 * more permissive than the thing it doubles.
 */
function mine<T extends { organizationId: string }>(organizationId: string, rows: T[]): T[] {
  return rows.filter((row) => row.organizationId === organizationId);
}

function isValidPreviewPayload(payload: unknown): payload is { readonly status: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const entries = Object.entries(payload);
  const entry = entries[0];
  return (
    entries.length === 1 &&
    entry !== undefined &&
    entry[0] === 'status' &&
    ['not_started', 'starting', 'ready', 'failed'].includes(entry[1] as string)
  );
}

/** The in-memory counterpart to CP-10's tenant-project row lock. */
async function withSpecificationLock<T>(
  data: InMemoryTenantData,
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = data.specificationLocks.get(projectId) ?? Promise.resolve();
  let unlock: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  data.specificationLocks.set(projectId, current);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (data.specificationLocks.get(projectId) === current) data.specificationLocks.delete(projectId);
  }
}

async function withRunCreateLock<T>(
  data: InMemoryTenantData,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = data.runCreateLocks.get(runId) ?? Promise.resolve();
  let unlock: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  data.runCreateLocks.set(runId, current);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (data.runCreateLocks.get(runId) === current) data.runCreateLocks.delete(runId);
  }
}

async function withCapabilityScanLock<T>(
  data: InMemoryTenantData,
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = data.capabilityScanLocks.get(projectId) ?? Promise.resolve();
  let unlock: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  data.capabilityScanLocks.set(projectId, current);
  await previous;
  try {
    return await work();
  } finally {
    unlock();
    if (data.capabilityScanLocks.get(projectId) === current) {
      data.capabilityScanLocks.delete(projectId);
    }
  }
}

/** One organization's view of `data`. A free function, so nothing aliases `this`. */
function handleFor(data: InMemoryTenantData, orgId: string): TenantDatabase {
  return {
    organizationId: orgId,

    previewShares: {
      getById(shareId) {
        return Promise.resolve(
          mine(orgId, data.previewShares).find((row) => row.id === shareId),
        );
      },
      listByProject(projectId) {
        return Promise.resolve(
          mine(orgId, data.previewShares).filter((row) => row.projectId === projectId),
        );
      },
    },

    auditEvents: {
      list(request): Promise<StorePage<AuditEvent>> {
        const rows = mine(orgId, data.auditEvents)
          .filter((event) => request.cursor === undefined || event.id < request.cursor)
          .filter((event) => request.actorId === undefined || event.actorId === request.actorId)
          .filter((event) => request.action === undefined || event.action === request.action)
          .filter((event) => request.targetType === undefined || event.targetType === request.targetType)
          .filter((event) => request.targetId === undefined || event.targetId === request.targetId)
          .filter((event) => request.from === undefined || event.occurredAt >= request.from)
          .filter((event) => request.to === undefined || event.occurredAt <= request.to)
          .sort((left, right) => (left.id < right.id ? 1 : -1));
        const items = rows.slice(0, request.limit);
        return Promise.resolve({
          items,
          nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
        });
      },
    },

    projects: {
      list(request): Promise<StorePage<Project>> {
        const rows = mine(orgId, data.projects)
          .filter((project) => request.includeArchived === true || project.archivedAt === null)
          .filter((project) => request.cursor === undefined || project.id < request.cursor)
          // Descending id: monotonic ULIDs make that newest-first and a total
          // order, which is what makes the cursor unambiguous.
          .sort((left, right) => (left.id < right.id ? 1 : -1));

        const items = rows.slice(0, request.limit);
        return Promise.resolve({
          items,
          nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
        });
      },

      getById(projectId): Promise<Project | undefined> {
        return Promise.resolve(
          mine(orgId, data.projects).find((project) => project.id === projectId),
        );
      },

      async create(input: NewProjectInput): Promise<CreatedProject> {
        const taken = mine(orgId, data.projects).some((project) => project.slug === input.slug);
        if (taken) {
          return 'slug_taken';
        }

        const project: Project = {
          id: newId('proj'),
          organizationId: orgId,
          name: input.name,
          slug: input.slug,
          description: input.description,
          sourceType: input.sourceType,
          supportLevel: input.supportLevel,
          createdBy: input.createdBy,
          createdAt: input.now,
          archivedAt: null,
        };

        // Outside the store until everything below succeeds: this is the
        // transaction boundary, modelled.
        const { internalRepoRef } = await input.repository({
          project,
          defaultBranch: DEFAULT_BRANCH,
        });

        const repository: Repository = {
          id: newId('repo'),
          organizationId: orgId,
          projectId: project.id,
          provider: INTERNAL_PROVIDER,
          internalRepoRef,
          externalRepoRef: null,
          defaultBranch: DEFAULT_BRANCH,
          syncPolicy: NO_SYNC,
          // Null, like the shipping record-only path: the row exists, the
          // repository on disk does not (plan 06 GIT-2 sets this).
          provisionedAt: null,
        };
        const branch: Branch = {
          id: newId('br'),
          organizationId: orgId,
          projectId: project.id,
          name: DEFAULT_BRANCH,
          headCommitSha: null,
          baseBranchId: null,
          status: BRANCH_ACTIVE,
        };
        const created: Environment[] = DEFAULT_ENVIRONMENTS.map((name) => ({
          id: newId('env'),
          organizationId: orgId,
          projectId: project.id,
          name,
          type: name,
          deploymentProvider: null,
          databaseConnectionId: null,
          createdAt: input.now,
        }));

        const resources = { project, repository, branches: [branch], environments: created };
        await input.audit(NO_TRANSACTION, resources);

        data.projects.push(project);
        data.repositories.push(repository);
        data.branches.push(branch);
        data.environments.push(...created);
        return resources;
      },

      async update(input: UpdateProjectInput): Promise<UpdatedProject> {
        const existing = mine(orgId, data.projects).find(
          (project) => project.id === input.projectId,
        );
        if (existing === undefined) {
          return undefined;
        }
        const { patch } = input;
        if (
          patch.slug !== undefined &&
          mine(orgId, data.projects).some(
            (project) => project.slug === patch.slug && project.id !== existing.id,
          )
        ) {
          return 'slug_taken';
        }

        const updated: Project = {
          ...existing,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.slug === undefined ? {} : { slug: patch.slug }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.archived === undefined
            ? {}
            : { archivedAt: patch.archived ? input.now : null }),
        };
        await input.audit(NO_TRANSACTION, updated);
        data.projects.splice(data.projects.indexOf(existing), 1, updated);
        return updated;
      },
    },

    projectSummaries: {
      forProjects(projectIds) {
        const tenantProjects = projectIds.map((projectId) =>
          mine(orgId, data.projects).find((project) => project.id === projectId),
        );
        if (tenantProjects.some((project) => project === undefined)) return Promise.resolve(undefined);
        return Promise.resolve(
          tenantProjects.map((project) => {
            if (project === undefined) throw new Error('tenant project disappeared');
            const visible = mine(orgId, data.events)
              .filter((event) => event.projectId === project.id && event.visibility === 'user')
              .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
            const preview = visible.find(
              (event) =>
                ['preview.starting', 'preview.ready', 'preview.failed'].includes(event.type) &&
                isValidPreviewPayload(event.payloadJson),
            );
            const productionEnvironment = mine(orgId, data.environments).find(
              (environment) => environment.projectId === project.id && environment.type === 'production',
            );
            const release =
              productionEnvironment === undefined
                ? undefined
                : mine(orgId, data.releases)
                    .filter(
                      (candidate) =>
                        candidate.projectId === project.id &&
                        candidate.environmentId === productionEnvironment.id,
                    )
                    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
            const deployment =
              release === undefined
                ? undefined
                : mine(orgId, data.deployments)
                    .filter((candidate) => candidate.releaseId === release.id)
                    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0];
            return {
              projectId: project.id,
              lastActivityAt: visible[0]?.occurredAt ?? null,
              preview:
                preview === undefined
                  ? null
                  : { occurredAt: preview.occurredAt, payload: preview.payloadJson },
              release:
                release === undefined
                  ? null
                  : { id: release.id, status: release.status, createdAt: release.createdAt },
              deployment:
                deployment === undefined
                  ? null
                  : {
                      status: deployment.status,
                      occurredAt: deployment.completedAt ?? deployment.startedAt,
                    },
            };
          }),
        );
      },
    },

    specifications: {
      getByProjectVersion(projectId, version): Promise<Specification | undefined> {
        return Promise.resolve(
          mine(orgId, data.specifications).find(
            (row) => row.projectId === projectId && row.version === version,
          ),
        );
      },
      getForProject(projectId, specificationId): Promise<Specification | undefined> {
        return Promise.resolve(
          mine(orgId, data.specifications).find(
            (row) => row.projectId === projectId && row.id === specificationId,
          ),
        );
      },
      async create(input: NewSpecificationInput): Promise<Specification> {
        return await withSpecificationLock(data, `${orgId}:${input.projectId}`, async () => {
          const existing = mine(orgId, data.specifications).find((row) => row.id === input.id);
          if (existing !== undefined) return existing;
          const version =
            Math.max(
              0,
              ...mine(orgId, data.specifications)
                .filter((row) => row.projectId === input.projectId)
                .map((row) => row.version),
            ) + 1;
          // Without the lock above both concurrent requests stop here with the
          // same candidate version. The test switch turns that scheduling point
          // into an actual interleaving instead of relying on timing luck.
          if (data.yieldSpecificationCreates) await Promise.resolve();
          const created: Specification = {
            id: input.id,
            organizationId: orgId,
            projectId: input.projectId,
            version,
            status: 'draft',
            contentJson: input.content,
            createdBy: input.createdBy,
            approvedBy: null,
            approvedAt: null,
          };
          await input.audit(NO_TRANSACTION, created);
          data.specifications.push(created);
          return created;
        });
      },
      async update(input: UpdateSpecificationInput) {
        return await withSpecificationLock(data, `${orgId}:${input.projectId}:${String(input.version)}`, async () => {
          const existing = mine(orgId, data.specifications).find(
            (row) => row.projectId === input.projectId && row.version === input.version,
          );
          if (existing === undefined) return undefined;
          const operationId = `${orgId}:${input.projectId}:${String(input.version)}`;
          if (data.specificationOperations.get(operationId)?.has(input.operationKey)) return existing;
          if (existing.status !== 'draft') return 'immutable' as const;
          const updated: Specification = { ...existing, contentJson: input.content };
          await input.audit(NO_TRANSACTION, updated);
          data.specifications.splice(data.specifications.indexOf(existing), 1, updated);
          const completedOperations = data.specificationOperations.get(operationId) ?? new Set<string>();
          completedOperations.add(input.operationKey);
          data.specificationOperations.set(operationId, completedOperations);
          return updated;
        });
      },
      async approve(input: ApproveSpecificationInput) {
        return await withSpecificationLock(data, `${orgId}:${input.projectId}:${String(input.version)}`, async () => {
          const existing = mine(orgId, data.specifications).find(
            (row) => row.projectId === input.projectId && row.version === input.version,
          );
          if (existing === undefined) return undefined;
          if (
            input.expectedContentEtag !== undefined &&
            specificationContentEtag(existing.contentJson) !== input.expectedContentEtag
          ) {
            return 'content_changed' as const;
          }
          if (existing.status === 'approved') return existing;
          const approved: Specification = {
            ...existing,
            status: 'approved',
            approvedBy: input.approvedBy,
            approvedAt: input.approvedAt,
          };
          await input.audit(NO_TRANSACTION, approved);
          data.specifications.splice(data.specifications.indexOf(existing), 1, approved);
          return approved;
        });
      },
    },

    repositories: {
      forProject(projectId): Promise<Repository | undefined> {
        return Promise.resolve(
          mine(orgId, data.repositories).find((row) => row.projectId === projectId),
        );
      },
    },

    branches: {
      byProject(projectId): Promise<Branch[]> {
        return Promise.resolve(
          mine(orgId, data.branches).filter((row) => row.projectId === projectId),
        );
      },
      getForProject(projectId, branchId): Promise<Branch | undefined> {
        return Promise.resolve(
          mine(orgId, data.branches).find(
            (row) => row.projectId === projectId && row.id === branchId,
          ),
        );
      },
    },

    environments: {
      byProject(projectId): Promise<Environment[]> {
        return Promise.resolve(
          mine(orgId, data.environments).filter((row) => row.projectId === projectId),
        );
      },
      getForProject(projectId, environmentId): Promise<Environment | undefined> {
        return Promise.resolve(
          mine(orgId, data.environments).find(
            (row) => row.projectId === projectId && row.id === environmentId,
          ),
        );
      },
    },

    secrets: {
      list(request: SecretListRequest): Promise<StorePage<SecretMetadata>> {
        const rows = mine(orgId, data.secrets)
          .filter((secret) => secret.projectId === request.projectId)
          .filter((secret) => request.cursor === undefined || secret.id < request.cursor)
          .sort((left, right) => (left.id < right.id ? 1 : -1));
        const items = rows.slice(0, request.limit);
        return Promise.resolve({
          items,
          nextCursor: rows.length > request.limit ? (items.at(-1)?.id ?? null) : null,
        });
      },

      getById(secretId): Promise<SecretMetadata | undefined> {
        return Promise.resolve(mine(orgId, data.secrets).find((row) => row.id === secretId));
      },

      async create(input: NewSecretInput): Promise<CreatedSecret> {
        // The two partial unique indexes of `packages/db/drizzle/0007`, in the
        // one form that matters here: a null environment is a scope of its own,
        // not a wildcard that collides with every other row.
        const taken = mine(orgId, data.secrets).some(
          (secret) =>
            secret.projectId === input.projectId &&
            secret.environmentId === input.environmentId &&
            secret.name === input.name,
        );
        if (taken) {
          return 'name_taken';
        }

        const id = newId('sec');
        const secret: SecretMetadata = {
          id,
          organizationId: orgId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          name: input.name,
          encryptedValueRef: vaultRef(id),
          createdBy: input.createdBy,
          rotatedAt: null,
          keyVersion: input.envelope.keyVersion,
          createdAt: input.now,
        };

        // Outside the store until the audit hook returns: the transaction
        // boundary, modelled, exactly as project creation models it.
        await input.audit(NO_TRANSACTION, secret);
        data.secrets.push(secret);
        data.ciphertexts.set(secret.id, input.envelope);
        return secret;
      },

      async rotate(input: RotateSecretInput): Promise<SecretMetadata | undefined> {
        const existing = mine(orgId, data.secrets).find((row) => row.id === input.secretId);
        if (existing === undefined) {
          return undefined;
        }
        const rotated: SecretMetadata = {
          ...existing,
          rotatedAt: input.now,
          keyVersion: input.envelope.keyVersion,
        };
        await input.audit(NO_TRANSACTION, rotated);
        data.secrets.splice(data.secrets.indexOf(existing), 1, rotated);
        // Overwritten, not appended: P0 keeps no version history, and a double
        // that kept one would let a test pass that the real store fails.
        data.ciphertexts.set(rotated.id, input.envelope);
        return rotated;
      },

      async delete(input: DeleteSecretInput): Promise<SecretMetadata | undefined> {
        const existing = mine(orgId, data.secrets).find((row) => row.id === input.secretId);
        if (existing === undefined) {
          return undefined;
        }
        await input.audit(NO_TRANSACTION, existing);
        data.secrets.splice(data.secrets.indexOf(existing), 1);
        // The ON DELETE CASCADE, modelled.
        data.ciphertexts.delete(existing.id);
        return existing;
      },

      async readEnvelope(input: ReadSecretInput): Promise<StoredSecret | undefined> {
        const secret = mine(orgId, data.secrets).find((row) => row.id === input.secretId);
        const envelope = secret === undefined ? undefined : data.ciphertexts.get(secret.id);
        if (secret === undefined || envelope === undefined) {
          return undefined;
        }
        // Before the return, like the real one: an audit hook that throws must
        // take the read with it, which is what `test/secrets.test.ts` asserts.
        await input.audit(NO_TRANSACTION, secret);
        return { secret, envelope };
      },
    },

    contracts: {
      latestForProject(projectId): Promise<ProjectContract | undefined> {
        const rows = mine(orgId, data.contracts)
          .filter((row) => row.projectId === projectId)
          .sort((left, right) => right.version - left.version);
        return Promise.resolve(rows[0]);
      },
      async recordScan(input) {
        return await withCapabilityScanLock(data, input.projectId, async () => {
          const project = mine(orgId, data.projects).find((row) => row.id === input.projectId);
          if (project === undefined) return undefined;
          const existingArtifact = mine(orgId, data.artifacts).find(
            (row) =>
              row.projectId === project.id &&
              row.type === 'capability_scan_report' &&
              (row.metadataJson as { scanId?: unknown }).scanId === input.scanId,
          );
          if (existingArtifact !== undefined) {
            const contractId = (existingArtifact.metadataJson as { contractId?: unknown })
              .contractId;
            const existingContract = mine(orgId, data.contracts).find(
              (row) => row.projectId === project.id && row.id === contractId,
            );
            if (existingContract === undefined) {
              throw new Error('capability scan replay references a missing contract');
            }
            return { contract: existingContract, artifact: existingArtifact };
          }
        const version =
          Math.max(
            0,
            ...mine(orgId, data.contracts)
              .filter((row) => row.projectId === project.id)
              .map((row) => row.version),
          ) + 1;
        const contract: ProjectContract = {
          id: newId('pc'),
          organizationId: orgId,
          projectId: project.id,
          version,
          detectedFramework: input.result.detectedFramework,
          contractJson: input.result.contract,
          createdAt: input.createdAt,
        };
        const artifact: Artifact = {
          id: newId('art'),
          organizationId: orgId,
          projectId: project.id,
          runId: null,
          taskId: null,
          type: 'capability_scan_report',
          storageRef: input.reportArtifact.storageRef,
          contentHash: input.reportArtifact.contentHash,
          metadataJson: {
            scanId: input.scanId,
            contractId: contract.id,
            verifiedEligible: input.result.verifiedEligible,
            database: input.result.database,
            auth: input.result.auth,
            deployment: input.result.deployment,
            tests: input.result.tests,
            observability: input.result.observability,
            reportCard: input.result.reportCard,
          },
          createdAt: input.createdAt,
        };
          await input.audit(NO_TRANSACTION, { contract, artifact });
          data.contracts.push(contract);
          data.artifacts.push(artifact);
        data.projects.splice(data.projects.indexOf(project), 1, {
          ...project,
          supportLevel: input.result.supportLevel,
        });
          return { contract, artifact };
        });
      },
    },

    attachments: {
      getById(attachmentId) {
        return Promise.resolve(
          mine(orgId, data.artifacts).find(
            (row) => row.id === attachmentId && row.type === 'image_attachment',
          ),
        );
      },
      async create(input) {
        const project = mine(orgId, data.projects).find((row) => row.id === input.projectId);
        if (project === undefined) return undefined;
        const existing = mine(orgId, data.artifacts).find((row) => row.id === input.id);
        if (existing !== undefined) return existing;
        const created: Artifact = {
          id: input.id,
          organizationId: orgId,
          projectId: input.projectId,
          runId: null,
          taskId: null,
          type: 'image_attachment',
          storageRef: input.storageRef,
          contentHash: input.contentHash,
          metadataJson: input.metadata,
          createdAt: input.createdAt,
        };
        await input.audit(NO_TRANSACTION, created);
        data.artifacts.push(created);
        return created;
      },
    },

    runs: {
      byProject(projectId): Promise<AgentRun[]> {
        return Promise.resolve(mine(orgId, data.runs).filter((row) => row.projectId === projectId));
      },
      getById(runId): Promise<AgentRun | undefined> {
        return Promise.resolve(mine(orgId, data.runs).find((row) => row.id === runId));
      },
      async create(input) {
        return await withRunCreateLock(data, `${orgId}:${input.id}`, async () => {
          const existing = mine(orgId, data.runs).find((row) => row.id === input.id);
          if (existing !== undefined) {
            return {
              outcome:
                existing.requestFingerprint === input.requestFingerprint
                  ? 'recovered'
                  : 'conflict',
              run: existing,
            } as const;
          }
          const run: AgentRun = {
            id: input.id,
            organizationId: orgId,
            projectId: input.projectId,
            branchId: input.branchId,
            mode: input.mode,
            appType: input.appType,
            model: input.model,
            requestFingerprint: input.requestFingerprint,
            status: 'queued',
            specificationId: null,
            temporalWorkflowId: input.workflowId,
            startedBy: input.startedBy,
            budgetJson: input.budget,
            startedAt: input.now,
            completedAt: null,
          };
          input.authorize(run);
          await input.audit(NO_TRANSACTION, run);
          data.runs.push(run);
          data.runAccounting.set(run.id, input.accounting);
          return { outcome: 'created', run } as const;
        });
      },
      async claimOperation(input) {
        const existing = mine(orgId, data.runs).find((row) => row.id === input.runId);
        if (existing === undefined) return undefined;
        const operation = data.operations.get(`run:${existing.id}`);
        if (operation?.state === 'requested') {
          return {
            entity: existing,
            outcome: operation.key === input.operationKey ? 'dispatch' : 'blocked',
          } as const;
        }
        if (operation?.key === input.operationKey)
          return { entity: existing, outcome: operation.state } as const;
        if (!input.allowedStatuses.includes(existing.status))
          return { entity: existing, outcome: 'blocked' } as const;
        await input.audit(NO_TRANSACTION, existing);
        data.operations.set(`run:${existing.id}`, { key: input.operationKey, state: 'requested' });
        return { entity: existing, outcome: 'dispatch' } as const;
      },
      async completeOperation(input) {
        const existing = mine(orgId, data.runs).find((row) => row.id === input.runId);
        if (existing === undefined || existing.status !== input.expectedStatus) return undefined;
        const operation = data.operations.get(`run:${existing.id}`);
        if (operation?.key !== input.operationKey || operation.state !== 'requested')
          return undefined;
        const updated: AgentRun = {
          ...existing,
          status: input.status,
          completedAt: input.completedAt,
        };
        await input.audit(NO_TRANSACTION, updated);
        data.runs.splice(data.runs.indexOf(existing), 1, updated);
        data.operations.set(`run:${updated.id}`, { key: input.operationKey, state: 'completed' });
        return updated;
      },
      async rejectOperation(input) {
        const existing = mine(orgId, data.runs).find((row) => row.id === input.runId);
        const operation =
          existing === undefined ? undefined : data.operations.get(`run:${existing.id}`);
        if (
          existing === undefined ||
          operation?.key !== input.operationKey ||
          operation.state !== 'requested'
        )
          return undefined;
        await input.audit(NO_TRANSACTION, existing);
        data.operations.set(`run:${existing.id}`, { key: input.operationKey, state: 'rejected' });
        return existing;
      },
    },

    approvals: {
      async resolve(input) {
        const existing = mine(orgId, data.approvals).find(
          (row) =>
            row.id === input.approvalId &&
            row.runId === input.runId &&
            row.type === input.type,
        );
        if (existing === undefined) return undefined;
        if (existing.status !== 'pending') {
          return {
            outcome: existing.status === input.decision ? 'replayed' : 'conflict',
            approval: existing,
          } as const;
        }
        const resolved: Approval = {
          ...existing,
          status: input.decision,
          responseJson: { decision: input.decision, reason: input.reason },
          resolvedAt: input.resolvedAt,
          resolvedBy: input.resolvedBy,
        };
        await input.audit(NO_TRANSACTION, resolved);
        data.approvals.splice(data.approvals.indexOf(existing), 1, resolved);
        return { outcome: 'resolved', approval: resolved } as const;
      },
    },

    workspaces: {
      getById(id) {
        return Promise.resolve(mine(orgId, data.workspaces).find((row) => row.id === id));
      },
      async create(input) {
        const base: Workspace = {
          id: input.id,
          organizationId: orgId,
          projectId: input.projectId,
          branchId: input.branchId,
          provider: 'modal',
          providerWorkspaceId: null,
          status: 'requested',
          resourceProfile: input.resourceProfile,
          runId: null,
          taskId: null,
          purpose: null,
          environment: null,
          imageTag: null,
          previewMonitorEnabled: false,
          previewMonitorOwnerId: null,
          previewMonitorLeaseExpiresAt: null,
          snapshotRef: null,
          createdAt: input.now,
          lastActiveAt: null,
          terminatedAt: null,
        };
        const existing = mine(orgId, data.workspaces).find((row) => row.id === base.id);
        if (existing !== undefined) return existing;
        await input.audit(NO_TRANSACTION, base);
        data.workspaces.push(base);
        return base;
      },
      async completeCreate(input) {
        const existing = mine(orgId, data.workspaces).find((row) => row.id === input.workspaceId);
        if (
          existing === undefined ||
          existing.providerWorkspaceId !== null ||
          existing.status !== 'requested'
        )
          return undefined;
        const updated: Workspace = {
          ...existing,
          providerWorkspaceId: input.providerWorkspaceId,
          status: input.status,
        };
        await input.audit(NO_TRANSACTION, updated);
        data.workspaces.splice(data.workspaces.indexOf(existing), 1, updated);
        return updated;
      },
      async claimOperation(input) {
        const existing = mine(orgId, data.workspaces).find((row) => row.id === input.workspaceId);
        if (existing === undefined) return undefined;
        const operation = data.operations.get(`workspace:${existing.id}`);
        if (operation?.state === 'requested')
          return {
            entity: existing,
            outcome: operation.key === input.operationKey ? 'dispatch' : 'blocked',
          } as const;
        if (operation?.key === input.operationKey)
          return { entity: existing, outcome: operation.state } as const;
        if (!input.allowedStatuses.includes(existing.status))
          return { entity: existing, outcome: 'blocked' } as const;
        await input.audit(NO_TRANSACTION, existing);
        data.operations.set(`workspace:${existing.id}`, {
          key: input.operationKey,
          state: 'requested',
        });
        return { entity: existing, outcome: 'dispatch' } as const;
      },
      async completeOperation(input) {
        const existing = mine(orgId, data.workspaces).find((row) => row.id === input.workspaceId);
        const operation =
          existing === undefined ? undefined : data.operations.get(`workspace:${existing.id}`);
        if (
          existing === undefined ||
          existing.status !== input.expectedStatus ||
          operation?.key !== input.operationKey ||
          operation.state !== 'requested'
        )
          return undefined;
        const updated: Workspace = {
          ...existing,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.snapshotRef === undefined ? {} : { snapshotRef: input.snapshotRef }),
          ...(input.terminatedAt === undefined ? {} : { terminatedAt: input.terminatedAt }),
          lastActiveAt: input.now,
        };
        await input.audit(NO_TRANSACTION, updated);
        data.workspaces.splice(data.workspaces.indexOf(existing), 1, updated);
        data.operations.set(`workspace:${updated.id}`, {
          key: input.operationKey,
          state: 'completed',
        });
        return updated;
      },
      async rejectOperation(input) {
        const existing = mine(orgId, data.workspaces).find((row) => row.id === input.workspaceId);
        const operation =
          existing === undefined ? undefined : data.operations.get(`workspace:${existing.id}`);
        if (
          existing === undefined ||
          operation?.key !== input.operationKey ||
          operation.state !== 'requested'
        )
          return undefined;
        await input.audit(NO_TRANSACTION, existing);
        data.operations.set(`workspace:${existing.id}`, {
          key: input.operationKey,
          state: 'rejected',
        });
        return existing;
      },
    },

    events: {
      byRun(runId): Promise<AgentEventRow[]> {
        return Promise.resolve(mine(orgId, data.events).filter((row) => row.runId === runId));
      },
      async ingest(input) {
        const run = mine(orgId, data.runs).find(
          (row) => row.id === input.runId && row.projectId === input.projectId,
        );
        if (run === undefined) return { kind: 'run_not_found' } as const;
        const userMessage = input.events.find((event) => event.type === 'message.user');
        if (
          userMessage !== undefined &&
          !['queued', 'running', 'paused', 'waiting_for_approval'].includes(run.status)
        ) {
          return { kind: 'run_not_active' } as const;
        }
        const messageId = userMessage?.payload['messageId'];
        if (typeof messageId === 'string') {
          const existing = mine(orgId, data.events).find(
            (event) =>
              event.runId === input.runId &&
              event.type === 'message.user' &&
              typeof event.payloadJson === 'object' &&
              event.payloadJson !== null &&
              (event.payloadJson as Record<string, unknown>)['messageId'] === messageId,
          );
          if (existing !== undefined) return { kind: 'stored', events: [existing] } as const;
        }
        let sequence = Math.max(
          0,
          ...mine(orgId, data.events)
            .filter((event) => event.runId === input.runId)
            .map((event) => event.sequence),
        );
        const stored: AgentEventRow[] = input.events.map((event) => ({
          id: newId('evt'),
          organizationId: orgId,
          runId: input.runId,
          sequence: (sequence += 1),
          projectId: input.projectId,
          phaseId: event.phaseId ?? null,
          taskId: event.taskId ?? null,
          agentId: event.agentId ?? null,
          type: event.type,
          visibility: event.visibility,
          payloadJson: event.payload,
          occurredAt: new Date(event.occurredAt),
        }));
        await input.audit(NO_TRANSACTION, stored);
        data.events.push(...stored);
        return { kind: 'stored', events: stored } as const;
      },
    },

    missionControl: {
      forRun(runId) {
        const phases = mine(orgId, data.phases)
          .filter((row) => row.runId === runId)
          .sort((left, right) => left.sequence - right.sequence);
        const phaseIds = new Set(phases.map((row) => row.id));
        const latestCeiling = mine(orgId, data.creditCeilingAdjustments)
          .filter((row) => row.runId === runId)
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id),
          )[0];
        const creditAccount = mine(orgId, data.creditAccounts).find(
          (row) => row.runId === runId,
        );
        return Promise.resolve({
          phases,
          tasks: mine(orgId, data.tasks).filter((row) => phaseIds.has(row.phaseId)),
          approvals: mine(orgId, data.approvals).filter((row) => row.runId === runId),
          artifacts: mine(orgId, data.artifacts).filter((row) => row.runId === runId),
          testRuns: mine(orgId, data.testRuns).filter((row) => row.runId === runId),
          verificationResults: mine(orgId, data.verificationResults).filter(
            (row) => row.runId === runId,
          ),
          creditAccount,
          effectiveCreditCeiling: latestCeiling?.absoluteCeiling ?? creditAccount?.baseCeiling,
        });
      },
    },
  };
}
