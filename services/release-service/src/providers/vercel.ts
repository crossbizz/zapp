import { createHash } from 'node:crypto';

import {
  CompatibilityResultSchema,
  DeploymentHandleSchema,
  DeploymentLogSchema,
  DeploymentStatusSchema,
  DomainInputSchema,
  DomainResultSchema,
  PreviewDeploymentInputSchema,
  ProductionDeploymentInputSchema,
  RollbackInputSchema,
  idSchema,
  type CompatibilityResult,
  type DeploymentHandle,
  type DeploymentLog,
  type DeploymentProvider,
  type DeploymentStatus,
  type DomainInput,
  type DomainResult,
  type PreviewDeploymentInput,
  type ProductionDeploymentInput,
  type ProjectContext,
  type RollbackInput,
} from '@zapp/contracts';
import { z } from 'zod';

const VERCEL_PROVIDER_ID = 'vercel';
const VERCEL_ID_PREFIX = 'vercel_';
const SUPPORTED_ADAPTERS = ['next', 'vite', 'astro', 'sveltekit', 'nuxt'] as const;

const VercelAdapterIdSchema = z.enum(SUPPORTED_ADAPTERS);
type VercelAdapterId = z.infer<typeof VercelAdapterIdSchema>;

const FrameworkByAdapter: Readonly<Record<VercelAdapterId, string>> = {
  next: 'nextjs',
  vite: 'vite',
  astro: 'astro',
  sveltekit: 'sveltekit',
  nuxt: 'nuxtjs',
};

const VercelConnectionSchema = z
  .object({
    provider: z.literal(VERCEL_PROVIDER_ID),
    status: z.literal('connected'),
    credentialRef: z.string().trim().min(1),
    configuration: z
      .object({
        projectId: z.string().trim().min(1),
        projectName: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/u),
        teamId: z.string().trim().min(1).optional(),
      })
      .strict(),
  })
  .strict();
type VercelConnection = z.infer<typeof VercelConnectionSchema>;

const VercelCredentialSchema = z.object({ token: z.string().trim().min(1) }).strict();
const ResolvedEnvironmentSchema = z.record(z.string());
const VercelHintSchema = z.object({ adapterId: VercelAdapterIdSchema }).strict();
const VercelArtifactFileSchema = z
  .object({
    path: z.string().min(1),
    contents: z.instanceof(Uint8Array),
  })
  .strict();
type VercelArtifactFile = z.infer<typeof VercelArtifactFileSchema>;

const VercelDeploymentSchema = z
  .object({
    id: z.string().trim().min(1),
    url: z.string().trim().min(1),
    readyState: z.string().trim().min(1),
    readyStateReason: z.string().optional(),
    errorMessage: z.string().nullable().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();
type VercelDeployment = z.infer<typeof VercelDeploymentSchema>;

const VercelEventSchema = z
  .object({
    type: z.string().trim().min(1),
    created: z.number().int().nonnegative(),
    text: z.string().optional(),
    payload: z.object({ text: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const VercelEventsResponseSchema = z.array(VercelEventSchema.nullable()).nullable();
type VercelEvent = z.infer<typeof VercelEventSchema> | null;

const VercelDomainResponseSchema = z
  .object({
    name: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    verified: z.boolean(),
    verification: z
      .array(
        z
          .object({
            type: z.enum(['A', 'CNAME', 'TXT']),
            domain: z.string().trim().min(1),
            value: z.string().min(1),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const ProviderIdentitySchema = z
  .object({
    projectId: idSchema('proj'),
    deploymentId: z.string().trim().min(1),
  })
  .strict();
type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;

export interface VercelConnectionPort {
  /** Reads the project-scoped `integration_connections` row for provider `vercel`. */
  resolve(input: { readonly projectId: string; readonly provider: 'vercel' }): Promise<unknown>;
}

/** Release-service's allowlisted, audited vault boundary. */
export interface VercelVaultPort {
  resolveCredential(input: {
    readonly projectId: string;
    readonly credentialRef: string;
    readonly reason: string;
  }): Promise<unknown>;
  resolveEnvironment(input: {
    readonly projectId: string;
    readonly environmentId: string;
    readonly references: Readonly<Record<string, string>>;
    readonly reason: string;
  }): Promise<unknown>;
  resolveRedactionValues(input: {
    readonly providerDeploymentId: string;
    readonly reason: string;
  }): Promise<unknown>;
}

/** Reads only the immutable sandbox-built directory named by the deployment artifact. */
export interface VercelArtifactPort {
  listFiles(input: {
    readonly projectId: string;
    readonly commitSha: string;
    readonly directory: string;
  }): Promise<unknown>;
}

/** Reads the project-adapter result retained for the exact commit. */
export interface VercelHintsPort {
  resolve(input: { readonly projectId: string; readonly commitSha: string }): Promise<unknown>;
}

export interface VercelDeploymentProviderDependencies {
  readonly apiBaseUrl?: string;
  readonly connection: VercelConnectionPort;
  readonly vault: VercelVaultPort;
  readonly artifacts: VercelArtifactPort;
  readonly hints: VercelHintsPort;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export class VercelProviderError extends Error {
  constructor(
    readonly code:
      | 'vercel_api_error'
      | 'vercel_cross_project_rollback'
      | 'vercel_invalid_artifact'
      | 'vercel_invalid_connection'
      | 'vercel_invalid_credential'
      | 'vercel_invalid_deployment_id'
      | 'vercel_invalid_hint'
      | 'vercel_invalid_logs_response'
      | 'vercel_invalid_provider_response'
      | 'vercel_invalid_vault_response'
      | 'vercel_preview_unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'VercelProviderError';
  }
}

export function detectVercelCompatibility(ctx: ProjectContext): Promise<CompatibilityResult> {
  const adapter = VercelAdapterIdSchema.safeParse(ctx.detection.adapterId);
  if (adapter.success) {
    return Promise.resolve(
      CompatibilityResultSchema.parse({
        providerId: VERCEL_PROVIDER_ID,
        compatible: true,
        reasons: [`Project adapter ${adapter.data} provides a Vercel deployment hint.`],
      }),
    );
  }
  return Promise.resolve(
    CompatibilityResultSchema.parse({
      providerId: VERCEL_PROVIDER_ID,
      compatible: false,
      reasons: ['Vercel requires a next, vite, astro, sveltekit, or nuxt project-adapter hint.'],
    }),
  );
}

export function encodeVercelProviderDeploymentId(
  projectIdValue: unknown,
  deploymentIdValue: unknown,
): string {
  const identity = ProviderIdentitySchema.parse({
    projectId: projectIdValue,
    deploymentId: deploymentIdValue,
  });
  return `${VERCEL_ID_PREFIX}${Buffer.from(JSON.stringify(identity)).toString('base64url')}`;
}

export function decodeVercelProviderDeploymentId(value: unknown): ProviderIdentity {
  const parsed = z.string().trim().min(1).safeParse(value);
  if (!parsed.success || !parsed.data.startsWith(VERCEL_ID_PREFIX)) {
    throw new VercelProviderError(
      'vercel_invalid_deployment_id',
      'The Vercel provider deployment id is invalid.',
    );
  }
  try {
    return ProviderIdentitySchema.parse(
      JSON.parse(
        Buffer.from(parsed.data.slice(VERCEL_ID_PREFIX.length), 'base64url').toString('utf8'),
      ),
    );
  } catch {
    throw new VercelProviderError(
      'vercel_invalid_deployment_id',
      'The Vercel provider deployment id is invalid.',
    );
  }
}

function providerUrl(hostname: string): string {
  if (hostname.startsWith('https://')) return new URL(hostname).toString();
  if (hostname.includes('://')) {
    throw new VercelProviderError(
      'vercel_invalid_provider_response',
      'Vercel returned an invalid deployment URL.',
    );
  }
  return new URL(`https://${hostname}`).toString();
}

function statusOf(deployment: VercelDeployment): {
  readonly state: DeploymentStatus['state'];
  readonly detail?: string;
} {
  switch (deployment.readyState.toUpperCase()) {
    case 'QUEUED':
      return { state: 'queued' };
    case 'INITIALIZING':
      return { state: 'deploying' };
    case 'BUILDING':
      return { state: 'building' };
    case 'READY':
      return { state: 'ready' };
    case 'ERROR':
      return {
        state: 'failed',
        detail:
          deployment.errorMessage ?? deployment.readyStateReason ?? 'Vercel deployment failed.',
      };
    case 'CANCELED':
    case 'CANCELLED':
      return { state: 'cancelled' };
    default:
      return { state: 'failed', detail: 'Vercel returned an unknown deployment state.' };
  }
}

function parseProvider<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new VercelProviderError('vercel_invalid_provider_response', message);
  }
  return parsed.data;
}

function exactVaultValues(
  references: Readonly<Record<string, string>>,
  value: unknown,
): Readonly<Record<string, string>> {
  const parsed = ResolvedEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new VercelProviderError(
      'vercel_invalid_vault_response',
      'The release vault returned invalid Vercel environment values.',
    );
  }
  const expected = Object.keys(references).sort();
  const actual = Object.keys(parsed.data).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new VercelProviderError(
      'vercel_invalid_vault_response',
      'The release vault returned the wrong Vercel environment names.',
    );
  }
  return parsed.data;
}

function deploymentFiles(value: unknown): readonly VercelArtifactFile[] {
  const parsed = z.array(VercelArtifactFileSchema).safeParse(value);
  if (!parsed.success || parsed.data.length === 0) {
    throw new VercelProviderError(
      'vercel_invalid_artifact',
      'The Vercel directory artifact must contain at least one file.',
    );
  }
  const seen = new Set<string>();
  const files = [...parsed.data].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of files) {
    const segments = file.path.split('/');
    if (
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      !file.path.startsWith('.vercel/output/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      seen.has(file.path)
    ) {
      throw new VercelProviderError(
        'vercel_invalid_artifact',
        'The Vercel directory artifact contains an invalid or duplicate path.',
      );
    }
    seen.add(file.path);
  }
  return files;
}

function redactionValues(
  value: unknown,
): readonly { readonly name: string; readonly value: string }[] {
  const parsed = ResolvedEnvironmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new VercelProviderError(
      'vercel_invalid_vault_response',
      'The release vault returned invalid Vercel log redaction values.',
    );
  }
  return Object.entries(parsed.data)
    .filter(([, secret]) => secret !== '')
    .map(([name, secret]) => ({ name, value: secret }))
    .sort(
      (left, right) =>
        right.value.length - left.value.length || left.name.localeCompare(right.name),
    );
}

function redact(
  message: string,
  values: readonly { readonly name: string; readonly value: string }[],
): string {
  return values.reduce(
    (current, secret) => current.split(secret.value).join(`[secret:${secret.name}]`),
    message,
  );
}

class VercelApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly teamId: string | undefined,
    private readonly requestFetch: typeof fetch,
  ) {}

  private url(path: string, query: readonly [string, string][] = []): URL {
    const url = new URL(path, this.baseUrl);
    if (this.teamId !== undefined) url.searchParams.set('teamId', this.teamId);
    for (const [name, value] of query) url.searchParams.set(name, value);
    return url;
  }

  private async request(
    path: string,
    init: RequestInit,
    expected: readonly number[],
    query: readonly [string, string][] = [],
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    const response = await this.requestFetch(this.url(path, query), { ...init, headers });
    if (!expected.includes(response.status)) {
      throw new VercelProviderError(
        'vercel_api_error',
        `The Vercel API rejected the ${init.method ?? 'GET'} operation.`,
      );
    }
    const text = await response.text();
    if (text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VercelProviderError(
        'vercel_invalid_provider_response',
        'The Vercel API returned invalid JSON.',
      );
    }
  }

  async syncEnvironment(
    projectId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    const body = Object.keys(values)
      .sort()
      .map((key) => ({ key, value: values[key] ?? '', type: 'sensitive', target: ['production'] }));
    if (body.length === 0) return;
    await this.request(
      `/v10/projects/${encodeURIComponent(projectId)}/env`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      [201],
      [['upsert', 'true']],
    );
  }

  async uploadFile(file: VercelArtifactFile, digest: string): Promise<void> {
    await this.request(
      '/v2/files',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(file.contents.byteLength),
          'x-vercel-digest': digest,
        },
        body: file.contents,
      },
      [200],
    );
  }

  async createDeployment(input: {
    readonly name: string;
    readonly projectId: string;
    readonly files: readonly {
      readonly file: string;
      readonly sha: string;
      readonly size: number;
    }[];
    readonly framework: string;
    readonly commitSha: string;
    readonly environmentId: string;
    readonly releaseId: string;
  }): Promise<VercelDeployment> {
    const value = await this.request(
      '/v13/deployments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: input.name,
          project: input.projectId,
          files: input.files,
          projectSettings: { framework: input.framework },
          target: 'production',
          meta: {
            zappCommitSha: input.commitSha,
            zappEnvironmentId: input.environmentId,
            zappReleaseId: input.releaseId,
          },
        }),
      },
      [200],
      [
        ['skipAutoDetectionConfirmation', '1'],
        ['prebuilt', '1'],
      ],
    );
    return parseProvider(
      VercelDeploymentSchema,
      value,
      'Vercel returned an invalid deployment response.',
    );
  }

  async getDeployment(deploymentId: string): Promise<VercelDeployment> {
    return parseProvider(
      VercelDeploymentSchema,
      await this.request(
        `/v13/deployments/${encodeURIComponent(deploymentId)}`,
        { method: 'GET' },
        [200],
      ),
      'Vercel returned an invalid deployment status response.',
    );
  }

  async getEvents(deploymentId: string): Promise<readonly VercelEvent[]> {
    const value = await this.request(
      `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
      { method: 'GET', headers: { accept: 'application/json' } },
      [200],
      [
        ['direction', 'forward'],
        ['follow', '0'],
        ['limit', '-1'],
      ],
    );
    const parsed = VercelEventsResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new VercelProviderError(
        'vercel_invalid_logs_response',
        'Vercel returned invalid deployment events.',
      );
    }
    return parsed.data ?? [];
  }

  async rollback(projectId: string, deploymentId: string, reason: string): Promise<void> {
    await this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`,
      { method: 'POST' },
      [201],
      [['description', reason]],
    );
  }

  async addDomain(
    projectId: string,
    hostname: string,
  ): Promise<z.infer<typeof VercelDomainResponseSchema>> {
    let value: unknown;
    try {
      value = await this.request(
        `/v10/projects/${encodeURIComponent(projectId)}/domains`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: hostname }),
        },
        [200],
      );
    } catch (error) {
      if (!(error instanceof VercelProviderError) || error.code !== 'vercel_api_error') throw error;
      value = await this.request(
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
        { method: 'GET' },
        [200],
      );
    }
    return parseProvider(
      VercelDomainResponseSchema,
      value,
      'Vercel returned an invalid domain response.',
    );
  }
}

function handleFromDeployment(projectId: string, deployment: VercelDeployment): DeploymentHandle {
  return DeploymentHandleSchema.parse({
    providerId: VERCEL_PROVIDER_ID,
    providerDeploymentId: encodeVercelProviderDeploymentId(projectId, deployment.id),
    url: providerUrl(deployment.url),
    state: statusOf(deployment).state,
    createdAt: new Date(deployment.createdAt).toISOString(),
  });
}

export function createVercelDeploymentProvider(
  dependencies: VercelDeploymentProviderDependencies,
): DeploymentProvider {
  const apiBaseUrl = dependencies.apiBaseUrl ?? 'https://api.vercel.com';
  const requestFetch = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  const resolveClient = async (
    projectId: string,
    reason: string,
  ): Promise<{ readonly connection: VercelConnection; readonly client: VercelApiClient }> => {
    const connectionResult = VercelConnectionSchema.safeParse(
      await dependencies.connection.resolve({ projectId, provider: VERCEL_PROVIDER_ID }),
    );
    if (!connectionResult.success) {
      throw new VercelProviderError(
        'vercel_invalid_connection',
        'The project does not have a valid connected Vercel account.',
      );
    }
    const credentialResult = VercelCredentialSchema.safeParse(
      await dependencies.vault.resolveCredential({
        projectId,
        credentialRef: connectionResult.data.credentialRef,
        reason,
      }),
    );
    if (!credentialResult.success) {
      throw new VercelProviderError(
        'vercel_invalid_credential',
        'The Vercel connection credential is unavailable.',
      );
    }
    return {
      connection: connectionResult.data,
      client: new VercelApiClient(
        apiBaseUrl,
        credentialResult.data.token,
        connectionResult.data.configuration.teamId,
        requestFetch,
      ),
    };
  };

  return {
    detectCompatibility: detectVercelCompatibility,

    createPreview(inputValue: PreviewDeploymentInput): Promise<DeploymentHandle> {
      PreviewDeploymentInputSchema.parse(inputValue);
      return Promise.reject(
        new VercelProviderError(
          'vercel_preview_unsupported',
          'Vercel provider-hosted previews are unsupported; zapp previews run in Modal sandboxes.',
        ),
      );
    },

    async deployProduction(inputValue: ProductionDeploymentInput): Promise<DeploymentHandle> {
      const input = ProductionDeploymentInputSchema.parse(inputValue);
      if (input.artifact.kind !== 'directory') {
        throw new VercelProviderError(
          'vercel_invalid_artifact',
          'Vercel production deployments require a sandbox-built directory artifact.',
        );
      }
      if (input.artifact.reference !== '.vercel/output') {
        throw new VercelProviderError(
          'vercel_invalid_artifact',
          'Vercel production deployments require the .vercel/output Build Output API directory.',
        );
      }
      const files = deploymentFiles(
        await dependencies.artifacts.listFiles({
          projectId: input.projectId,
          commitSha: input.commitSha,
          directory: input.artifact.reference,
        }),
      );
      const hintResult = VercelHintSchema.safeParse(
        await dependencies.hints.resolve({
          projectId: input.projectId,
          commitSha: input.commitSha,
        }),
      );
      if (!hintResult.success) {
        throw new VercelProviderError(
          'vercel_invalid_hint',
          'The exact commit does not have a supported Vercel project-adapter hint.',
        );
      }
      const { connection, client } = await resolveClient(
        input.projectId,
        `deploy release ${input.releaseId} to Vercel`,
      );
      const references = z.record(z.string()).parse(input.env);
      const environment = exactVaultValues(
        references,
        await dependencies.vault.resolveEnvironment({
          projectId: input.projectId,
          environmentId: input.environmentId,
          references,
          reason: `sync production environment for Vercel release ${input.releaseId}`,
        }),
      );
      await client.syncEnvironment(connection.configuration.projectId, environment);

      const uploadedDigests = new Set<string>();
      const uploaded = [];
      for (const file of files) {
        const sha = createHash('sha1').update(file.contents).digest('hex');
        if (!uploadedDigests.has(sha)) {
          await client.uploadFile(file, sha);
          uploadedDigests.add(sha);
        }
        uploaded.push({ file: file.path, sha, size: file.contents.byteLength });
      }
      const deployment = await client.createDeployment({
        name: connection.configuration.projectName,
        projectId: connection.configuration.projectId,
        files: uploaded,
        framework: FrameworkByAdapter[hintResult.data.adapterId],
        commitSha: input.commitSha,
        environmentId: input.environmentId,
        releaseId: input.releaseId,
      });
      return handleFromDeployment(input.projectId, deployment);
    },

    async getStatus(providerDeploymentIdValue: string): Promise<DeploymentStatus> {
      const identity = decodeVercelProviderDeploymentId(providerDeploymentIdValue);
      try {
        const { client } = await resolveClient(identity.projectId, 'read Vercel deployment status');
        const deployment = await client.getDeployment(identity.deploymentId);
        const status = statusOf(deployment);
        const detail =
          status.detail === undefined
            ? undefined
            : redact(
                status.detail,
                redactionValues(
                  await dependencies.vault.resolveRedactionValues({
                    providerDeploymentId: providerDeploymentIdValue,
                    reason: 'redact Vercel deployment status',
                  }),
                ),
              );
        return DeploymentStatusSchema.parse({
          providerDeploymentId: providerDeploymentIdValue,
          state: status.state,
          detail,
          url: providerUrl(deployment.url),
          updatedAt: new Date(deployment.updatedAt ?? deployment.createdAt).toISOString(),
        });
      } catch {
        return DeploymentStatusSchema.parse({
          providerDeploymentId: providerDeploymentIdValue,
          state: 'failed',
          detail: 'Vercel status could not be retrieved.',
          updatedAt: now().toISOString(),
        });
      }
    },

    async *streamLogs(providerDeploymentIdValue: string): AsyncIterable<DeploymentLog> {
      const identity = decodeVercelProviderDeploymentId(providerDeploymentIdValue);
      const { client } = await resolveClient(identity.projectId, 'read Vercel deployment logs');
      const secrets = redactionValues(
        await dependencies.vault.resolveRedactionValues({
          providerDeploymentId: providerDeploymentIdValue,
          reason: 'redact Vercel deployment logs',
        }),
      );
      for (const event of await client.getEvents(identity.deploymentId)) {
        if (event === null) continue;
        const message = event.text ?? event.payload?.text;
        if (message === undefined) continue;
        yield DeploymentLogSchema.parse({
          at: new Date(event.created).toISOString(),
          stream: ['error', 'fatal', 'stderr'].includes(event.type.toLowerCase())
            ? 'stderr'
            : 'stdout',
          message: redact(message, secrets),
        });
      }
    },

    async configureDomain(inputValue: DomainInput): Promise<DomainResult> {
      const input = DomainInputSchema.parse(inputValue);
      const { connection, client } = await resolveClient(
        input.projectId,
        'configure Vercel domain',
      );
      const result = await client.addDomain(connection.configuration.projectId, input.hostname);
      if (
        result.projectId !== connection.configuration.projectId ||
        result.name !== input.hostname
      ) {
        throw new VercelProviderError(
          'vercel_invalid_provider_response',
          'Vercel returned a domain for the wrong project or hostname.',
        );
      }
      const instructions = (result.verification ?? []).map((challenge) => ({
        type: challenge.type,
        name: challenge.domain,
        value: challenge.value,
      }));
      return DomainResultSchema.parse({
        hostname: input.hostname,
        status: result.verified ? 'active' : instructions.length > 0 ? 'pending_dns' : 'verifying',
        dnsInstructions: instructions,
      });
    },

    async rollback(inputValue: RollbackInput): Promise<DeploymentHandle> {
      const input = RollbackInputSchema.parse(inputValue);
      const target = decodeVercelProviderDeploymentId(input.toProviderDeploymentId);
      if (target.projectId !== input.projectId) {
        throw new VercelProviderError(
          'vercel_cross_project_rollback',
          'The rollback target belongs to a different Vercel project.',
        );
      }
      const { connection, client } = await resolveClient(
        input.projectId,
        'roll back Vercel production deployment',
      );
      await client.rollback(connection.configuration.projectId, target.deploymentId, input.reason);
      const deployment = await client.getDeployment(target.deploymentId);
      const handle = handleFromDeployment(input.projectId, deployment);
      if (handle.providerDeploymentId !== input.toProviderDeploymentId) {
        throw new VercelProviderError(
          'vercel_invalid_provider_response',
          'Vercel returned the wrong rollback deployment.',
        );
      }
      return handle;
    },
  };
}
