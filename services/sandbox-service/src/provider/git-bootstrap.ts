import { createHash } from 'node:crypto';

import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { idSchema, internalRepoRef, type ExecInput } from '@zapp/contracts';
import { z } from 'zod';

const TOKEN_TTL_SECONDS = 300;
const GIT_TIMEOUT_MS = 30_000;
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const BranchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith('-'), 'Branch name cannot start with a dash');

export const WorkspaceGitInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
    branchName: BranchNameSchema.optional(),
    providerWorkspaceId: z.string().min(1),
    runId: idSchema('run').optional(),
    taskId: idSchema('task').optional(),
    operationKey: OperationKeySchema,
  })
  .strict();
export type WorkspaceGitInput = z.infer<typeof WorkspaceGitInputSchema>;
export const WorkspaceGitBootstrapInputSchema = WorkspaceGitInputSchema.extend({
  branchName: BranchNameSchema,
}).strict();
export type WorkspaceGitBootstrapInput = z.infer<typeof WorkspaceGitBootstrapInputSchema>;

const GitTokenRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    access: z.enum(['read', 'write']),
    ttlSec: z.literal(TOKEN_TTL_SECONDS),
    runId: idSchema('run').optional(),
    taskId: idSchema('task').optional(),
  })
  .strict();
export type GitTokenRequest = z.infer<typeof GitTokenRequestSchema>;

export const GitTokenGrantSchema = z
  .object({
    token: z.string().min(1),
    username: z.string().min(1),
    cloneUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type GitTokenGrant = z.infer<typeof GitTokenGrantSchema>;

const WorkspaceExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const GitResultSchema = WorkspaceExecResultSchema.pick({
  exitCode: true,
  stdout: true,
  stderr: true,
}).strict();
export type WorkspaceGitResult = z.infer<typeof GitResultSchema>;

export interface GitTokenClient {
  mint(input: GitTokenRequest): Promise<unknown>;
}

export interface GitTokenClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createGitTokenClient(options: GitTokenClientOptions): GitTokenClient {
  const serviceUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'Git service URL must use HTTP or HTTPS')
    .parse(options.baseUrl);
  const endpoint = new URL('/internal/git/tokens', serviceUrl).toString();
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async mint(untrustedInput) {
      const input = GitTokenRequestSchema.parse(untrustedInput);
      const { token } = await signer.signServiceToken({
        service: 'sandbox-service',
        aud: 'git-service',
      });
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'x-zapp-service-token': token,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new Error('The Git token service could not be reached', { cause: error });
      }
      if (response.status !== 201) {
        throw new Error(`The Git token service refused the request (${String(response.status)})`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error('The Git token service returned invalid JSON', { cause: error });
      }
      return GitTokenGrantSchema.parse(body);
    },
  };
}

export interface WorkspaceGitCommandPort {
  exec(input: ExecInput, idempotencyKey: string): Promise<unknown>;
}

export interface WorkspaceGitService {
  bootstrap(input: WorkspaceGitBootstrapInput): Promise<void>;
  push(input: WorkspaceGitInput, args: readonly string[]): Promise<WorkspaceGitResult>;
}

export interface WorkspaceGitServiceOptions {
  readonly tokens: GitTokenClient;
  readonly commands: WorkspaceGitCommandPort;
}

function commandKey(operationKey: string, step: string): string {
  return `op_${createHash('sha256').update(`${operationKey}:${step}`).digest('hex')}`;
}

function validateCloneUrl(input: WorkspaceGitInput, rawUrl: string): string {
  const url = new URL(rawUrl);
  const localHttp =
    url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('Git service returned a repository URL with an invalid protocol');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Git service returned a repository URL with invalid components');
  }
  const expectedPath = `/${internalRepoRef(input)}.git`;
  if (url.pathname.toLowerCase() !== expectedPath) {
    throw new Error('Git service returned a repository URL for another project');
  }
  return url.toString();
}

function authenticatedCloneUrl(cleanCloneUrl: string, token: string): string {
  const url = new URL(cleanCloneUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}

function redactCredential(text: string, token: string): string {
  return text
    .split(token)
    .join('[secret:GIT_TOKEN]')
    .split(encodeURIComponent(token))
    .join('[secret:GIT_TOKEN]');
}

async function mint(
  input: WorkspaceGitInput,
  access: 'read' | 'write',
  tokens: GitTokenClient,
): Promise<GitTokenGrant> {
  const request = GitTokenRequestSchema.parse({
    organizationId: input.organizationId,
    projectId: input.projectId,
    access,
    ttlSec: TOKEN_TTL_SECONDS,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  });
  return GitTokenGrantSchema.parse(await tokens.mint(request));
}

async function execute(
  commands: WorkspaceGitCommandPort,
  input: WorkspaceGitInput,
  step: string,
  args: readonly string[],
) {
  return WorkspaceExecResultSchema.parse(
    await commands.exec(
      {
        providerWorkspaceId: input.providerWorkspaceId,
        command: 'git',
        args: [...args],
        timeoutMs: GIT_TIMEOUT_MS,
      },
      commandKey(input.operationKey, step),
    ),
  );
}

async function requireSuccess(
  commands: WorkspaceGitCommandPort,
  input: WorkspaceGitInput,
  step: string,
  args: readonly string[],
): Promise<void> {
  const result = await execute(commands, input, step, args);
  if (result.exitCode !== 0) {
    throw new Error('Workspace Git bootstrap failed');
  }
}

export function createWorkspaceGitService(
  options: WorkspaceGitServiceOptions,
): WorkspaceGitService {
  return {
    async bootstrap(untrustedInput) {
      const input = WorkspaceGitBootstrapInputSchema.parse(untrustedInput);
      const grant = await mint(input, 'read', options.tokens);
      const cleanCloneUrl = validateCloneUrl(input, grant.cloneUrl);
      const credentialUrl = authenticatedCloneUrl(cleanCloneUrl, grant.token);

      await requireSuccess(options.commands, input, 'clone', [
        '-c',
        'credential.helper=',
        '-c',
        `url.${credentialUrl}.insteadOf=${cleanCloneUrl}`,
        'clone',
        '--branch',
        input.branchName,
        '--single-branch',
        '--no-tags',
        cleanCloneUrl,
        '.',
      ]);
      await requireSuccess(options.commands, input, 'scrub-origin', [
        'remote',
        'set-url',
        'origin',
        cleanCloneUrl,
      ]);
      await requireSuccess(options.commands, input, 'credential-helper', [
        'config',
        'credential.helper',
        '',
      ]);
      await requireSuccess(options.commands, input, 'user-name', [
        'config',
        'user.name',
        'zapp-agent',
      ]);
      await requireSuccess(options.commands, input, 'user-email', [
        'config',
        'user.email',
        'agent@zapp.build',
      ]);
    },

    async push(untrustedInput, untrustedArgs) {
      const input = WorkspaceGitInputSchema.parse(untrustedInput);
      const args = z
        .array(z.enum(['--force-with-lease', '--set-upstream']))
        .max(2)
        .parse(untrustedArgs);
      const grant = await mint(input, 'write', options.tokens);
      const cleanCloneUrl = validateCloneUrl(input, grant.cloneUrl);
      const credentialUrl = authenticatedCloneUrl(cleanCloneUrl, grant.token);
      const result = await execute(options.commands, input, `push:${grant.username}`, [
        'push',
        ...args,
        credentialUrl,
        'HEAD',
      ]);
      return GitResultSchema.parse({
        exitCode: result.exitCode,
        stdout: redactCredential(result.stdout, grant.token),
        stderr: redactCredential(result.stderr, grant.token),
      });
    },
  };
}
