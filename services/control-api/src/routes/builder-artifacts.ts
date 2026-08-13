import { idSchema } from '@zapp/contracts';
import {
  MAX_PUBLIC_TEST_RUNS,
  SignedVerificationArtifactSchema,
  VerificationTestRunSchema,
} from '@zapp/verification-engine';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { ApiError } from '../errors.js';
import { actorOf } from '../plugins/auth.js';
import { authorize, tenantOf } from '../plugins/tenant.js';
import { WorkspaceSchema, toWorkspace } from '../tenant/view.js';
import { operationOf } from './runs.js';

const MAX_EDITOR_FILE_BYTES = 1_048_576;
const MAX_EDITOR_LIST_ENTRIES = 500;
const WorkspacePathSchema = z.string().min(1).max(1_024).superRefine((path, context) => {
  if (
    path.includes('\0') || path.startsWith('/') || path.startsWith('\\') ||
    /^[A-Za-z]:/u.test(path) || path.split('/').some((part) => part === '..')
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid workspace path' });
  }
});
const WorkspaceParamsSchema = z.object({ workspaceId: idSchema('ws') }).strict();
const ProjectParamsSchema = z.object({ projectId: idSchema('proj') }).strict();
const RunParamsSchema = z.object({ runId: idSchema('run') }).strict();
const EvidenceParamsSchema = RunParamsSchema.extend({ artifactId: idSchema('art') }).strict();
const WorkspaceListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(25).default(25) }).strict();
const FileListQuerySchema = z.object({
  path: WorkspacePathSchema.default('.'),
  glob: z.string().min(1).max(256).optional(),
  maxDepth: z.coerce.number().int().min(0).max(100).optional(),
}).strict();
const FileReadQuerySchema = z.object({ path: WorkspacePathSchema }).strict();
export const FileListResponseSchema = z.object({
  entries: z.array(z.object({
    path: WorkspacePathSchema,
    type: z.enum(['file', 'directory', 'symlink']),
  }).strict()).max(MAX_EDITOR_LIST_ENTRIES),
  truncated: z.boolean(),
}).strict();
export const FileReadResponseSchema = z.object({
  path: WorkspacePathSchema,
  dataBase64: z.string().max(Math.ceil(MAX_EDITOR_FILE_BYTES / 3) * 4),
  byteSize: z.number().int().nonnegative().max(MAX_EDITOR_FILE_BYTES),
  compareToken: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const FileEditBodySchema = z.object({
  path: WorkspacePathSchema,
  dataBase64: z.string()
    .max(Math.ceil(MAX_EDITOR_FILE_BYTES / 3) * 4)
    .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Expected canonical base64')
    .refine((value) => Buffer.from(value, 'base64').byteLength <= MAX_EDITOR_FILE_BYTES, 'File is too large'),
  expectedCompareToken: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
export const FileEditResponseSchema = z.object({
  path: WorkspacePathSchema,
  commitRef: z.string().regex(/^[0-9a-f]{7,64}$/u),
  compareToken: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
const CompareQuerySchema = z.object({
  before: z.string().regex(/^[0-9a-f]{40}$/u),
  after: z.string().regex(/^[0-9a-f]{40}$/u),
}).strict();
export const CommitComparisonSchema = z.object({
  beforeSha: z.string().regex(/^[0-9a-f]{40}$/u),
  afterSha: z.string().regex(/^[0-9a-f]{40}$/u),
  changedFiles: z.number().int().nonnegative(),
  files: z.array(z.object({
    path: z.string().max(1_024),
    status: z.string().max(32),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }).strict()).max(1_000),
  filesTruncated: z.boolean(),
  patch: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 1_048_576),
  patchTruncated: z.boolean(),
}).strict();
export const TestRunsResponseSchema = z.object({
  runs: z.array(VerificationTestRunSchema).max(MAX_PUBLIC_TEST_RUNS),
}).strict();
const EvidenceQuerySchema = z.object({ taskId: idSchema('task').optional() }).strict();
const IdempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().min(1).max(256),
}).passthrough();

export interface BuilderArtifactPort {
  listFiles(input: {
    readonly organizationId: string; readonly projectId: string; readonly workspaceId: string;
    readonly path: string; readonly glob?: string; readonly maxDepth?: number;
  }): Promise<z.infer<typeof FileListResponseSchema>>;
  readFile(input: {
    readonly organizationId: string; readonly projectId: string; readonly workspaceId: string;
    readonly path: string;
  }): Promise<z.infer<typeof FileReadResponseSchema>>;
  editFile(input: {
    readonly organizationId: string; readonly projectId: string; readonly workspaceId: string;
    readonly path: string; readonly dataBase64: string; readonly expectedCompareToken: string;
    readonly actorUserId: string; readonly operationKey: string;
  }): Promise<z.infer<typeof FileEditResponseSchema>>;
  compareCommits(input: {
    readonly organizationId: string; readonly projectId: string;
    readonly beforeSha: string; readonly afterSha: string;
  }): Promise<z.infer<typeof CommitComparisonSchema>>;
  listTests(input: {
    readonly organizationId: string; readonly projectId: string; readonly runId: string;
  }): Promise<z.infer<typeof TestRunsResponseSchema>>;
  signEvidence(input: {
    readonly organizationId: string; readonly projectId: string; readonly runId: string;
    readonly taskId: string | null; readonly artifactId: string;
  }): Promise<z.infer<typeof SignedVerificationArtifactSchema>>;
}

export class BuilderArtifactServiceError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'not_found' | 'conflict' = 'unavailable',
    options?: ErrorOptions,
  ) {
    super(`builder artifact service ${kind}`, options);
    this.name = 'BuilderArtifactServiceError';
  }
}

export function createUnavailableBuilderArtifactPort(): BuilderArtifactPort {
  const unavailable = (): Promise<never> => Promise.reject(new BuilderArtifactServiceError());
  return {
    listFiles: unavailable,
    readFile: unavailable,
    editFile: unavailable,
    compareCommits: unavailable,
    listTests: unavailable,
    signEvidence: unavailable,
  };
}

function serviceFailure(cause: unknown): ApiError {
  if (cause instanceof BuilderArtifactServiceError) {
    if (cause.kind === 'not_found') return new ApiError('builder_artifact_not_found', 404, 'That builder artifact does not exist.');
    if (cause.kind === 'conflict') return new ApiError('workspace_edit_conflict', 409, 'The file changed before this edit was applied.');
  }
  return new ApiError('builder_artifact_unavailable', 502, 'Builder artifacts are temporarily unavailable.');
}

export function registerBuilderArtifactRoutes(app: AppInstance, port: BuilderArtifactPort): void {
  app.get('/v1/projects/:projectId/workspaces', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: {
      params: ProjectParamsSchema,
      querystring: WorkspaceListQuerySchema,
      response: { 200: z.object({ workspaces: z.array(WorkspaceSchema).max(25) }).strict() },
    },
  }, async (request) => {
    const ctx = tenantOf(request);
    const project = await ctx.db.projects.getById(request.params.projectId);
    if (project === undefined) throw new ApiError('project_not_found', 404, 'That project does not exist.');
    authorize(ctx, 'view_project');
    return { workspaces: (await ctx.db.workspaces.byProject(project.id, request.query.limit)).map(toWorkspace) };
  });

  app.get('/v1/workspaces/:workspaceId/files', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: WorkspaceParamsSchema, querystring: FileListQuerySchema, response: { 200: FileListResponseSchema } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
    if (workspace === undefined) throw new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
    authorize(ctx, 'view_project');
    try {
      return await port.listFiles({
        organizationId: ctx.organizationId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        path: request.query.path,
        ...(request.query.glob === undefined ? {} : { glob: request.query.glob }),
        ...(request.query.maxDepth === undefined ? {} : { maxDepth: request.query.maxDepth }),
      });
    } catch (cause) { throw serviceFailure(cause); }
  });

  app.get('/v1/workspaces/:workspaceId/file', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: WorkspaceParamsSchema, querystring: FileReadQuerySchema, response: { 200: FileReadResponseSchema } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
    if (workspace === undefined) throw new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
    authorize(ctx, 'view_project');
    try {
      return await port.readFile({
        organizationId: ctx.organizationId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        path: request.query.path,
      });
    } catch (cause) { throw serviceFailure(cause); }
  });

  app.post('/v1/workspaces/:workspaceId/edits', {
    preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
    schema: {
      params: WorkspaceParamsSchema,
      headers: IdempotencyHeadersSchema,
      body: FileEditBodySchema,
      response: { 200: FileEditResponseSchema },
    },
  }, async (request) => {
    const ctx = tenantOf(request);
    const workspace = await ctx.db.workspaces.getById(request.params.workspaceId);
    if (workspace === undefined) throw new ApiError('workspace_not_found', 404, 'That workspace does not exist.');
    authorize(ctx, 'edit_code');
    try {
      return await port.editFile({
        organizationId: ctx.organizationId,
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        ...request.body,
        actorUserId: actorOf(request),
        operationKey: operationOf(request),
      });
    } catch (cause) { throw serviceFailure(cause); }
  });

  app.get('/v1/projects/:projectId/compare', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: ProjectParamsSchema, querystring: CompareQuerySchema, response: { 200: CommitComparisonSchema } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const project = await ctx.db.projects.getById(request.params.projectId);
    if (project === undefined) throw new ApiError('project_not_found', 404, 'That project does not exist.');
    authorize(ctx, 'view_project');
    try {
      return await port.compareCommits({
        organizationId: ctx.organizationId,
        projectId: project.id,
        beforeSha: request.query.before,
        afterSha: request.query.after,
      });
    } catch (cause) { throw serviceFailure(cause); }
  });

  app.get('/v1/runs/:runId/tests', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: { params: RunParamsSchema, response: { 200: TestRunsResponseSchema } },
  }, async (request) => {
    const ctx = tenantOf(request);
    const run = await ctx.db.runs.getById(request.params.runId);
    if (run === undefined) throw new ApiError('run_not_found', 404, 'That run does not exist.');
    authorize(ctx, 'view_project');
    try {
      return await port.listTests({ organizationId: ctx.organizationId, projectId: run.projectId, runId: run.id });
    } catch (cause) { throw serviceFailure(cause); }
  });

  app.get('/v1/runs/:runId/evidence/:artifactId', {
    preHandler: [app.requireSession, app.requireTenant],
    schema: {
      params: EvidenceParamsSchema,
      querystring: EvidenceQuerySchema,
      response: { 200: SignedVerificationArtifactSchema },
    },
  }, async (request) => {
    const ctx = tenantOf(request);
    const run = await ctx.db.runs.getById(request.params.runId);
    if (run === undefined) throw new ApiError('run_not_found', 404, 'That run does not exist.');
    authorize(ctx, 'view_project');
    try {
      return await port.signEvidence({
        organizationId: ctx.organizationId,
        projectId: run.projectId,
        runId: run.id,
        artifactId: request.params.artifactId,
        taskId: request.query.taskId ?? null,
      });
    } catch (cause) { throw serviceFailure(cause); }
  });
}
