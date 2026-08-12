import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { CommitShaSchema, idSchema, newId } from '@zapp/contracts';
import {
  agentPhases,
  agentRuns,
  agentTasks,
  artifactRetention,
  artifacts,
  testCases,
  testRuns,
  type Database,
  type NewArtifact,
  type NewArtifactRetention,
  type NewTestCase,
  type NewTestRun,
} from '@zapp/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const PLAYWRIGHT_TIMEOUT_MS = 10 * 60_000;
export const BROWSER_RUN_LEASE_MS = PLAYWRIGHT_TIMEOUT_MS + 2 * 60_000;
const TEST_ARTIFACT_RETENTION_MS = 30 * 86_400_000;

export function browserRunLeaseExpired(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() >= BROWSER_RUN_LEASE_MS;
}

export function classifyTestArtifacts(
  artifactRows: readonly NewArtifact[],
  createdAt: Date,
): NewArtifactRetention[] {
  const expiresAt = new Date(createdAt.getTime() + TEST_ARTIFACT_RETENTION_MS);
  return artifactRows.map((artifact) => ({
    artifactId: artifact.id,
    organizationId: artifact.organizationId,
    projectId: artifact.projectId,
    retentionClass: 'test',
    expiresAt,
  }));
}
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((path) => !path.startsWith('/') && !path.split(/[\\/]/u).includes('..'), {
    message: 'Path must stay inside the workspace',
  });
const BrowserRunScopeSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    testRunId: idSchema('trun'),
  })
  .strict();
const BrowserRunIdempotencyKeySchema = z
  .string()
  .max(256)
  .regex(/^browser-run:org_[0-9A-HJKMNP-TV-Z]{26}:proj_[0-9A-HJKMNP-TV-Z]{26}:trun_[0-9A-HJKMNP-TV-Z]{26}$/u);

export function browserRunIdempotencyKey(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly testRunId: string;
}): string {
  const parsed = BrowserRunScopeSchema.parse(input);
  return BrowserRunIdempotencyKeySchema.parse(
    `browser-run:${parsed.organizationId}:${parsed.projectId}:${parsed.testRunId}`,
  );
}

export const BrowserRunInputSchema = BrowserRunScopeSchema.extend({
  idempotencyKey: BrowserRunIdempotencyKeySchema,
  branchId: idSchema('br'),
  branchName: z.string().trim().min(1).max(255),
  workspaceId: idSchema('ws'),
  workspaceCreatedAt: z.string().datetime({ offset: true }),
  runId: idSchema('run'),
  taskId: idSchema('task'),
  commitSha: CommitShaSchema,
  suitePath: RelativePathSchema,
  playwrightConfigPath: RelativePathSchema.optional(),
  previewProxyUrl: z
    .string()
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
      message: 'Preview proxy URL must use HTTP or HTTPS',
    }),
  secretScan: z
    .object({
      status: z.literal('passed'),
      evidenceArtifactId: idSchema('art'),
    })
    .strict(),
})
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.idempotencyKey !==
      browserRunIdempotencyKey({
        organizationId: input.organizationId,
        projectId: input.projectId,
        testRunId: input.testRunId,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idempotencyKey'],
        message: 'Browser run key does not match its tenant and test run',
      });
    }
  });
export type BrowserRunInput = z.infer<typeof BrowserRunInputSchema>;

const BrowserCaseSummarySchema = z
  .object({
    testCaseId: idSchema('tcase'),
    name: z.string().min(1).max(2_048),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number().int().nonnegative(),
    flaky: z.boolean(),
    evidenceArtifactIds: z.array(idSchema('art')),
  })
  .strict();

export const BrowserRunSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    evidenceArtifactIds: z.array(idSchema('art')),
    cases: z.array(BrowserCaseSummarySchema),
    errorCode: z.literal('browser_run_failed').optional(),
  })
  .strict();
export type BrowserRunSummary = z.infer<typeof BrowserRunSummarySchema>;

export const BrowserRunOutputSchema = z
  .object({
    testRunId: idSchema('trun'),
    status: z.enum(['passed', 'failed', 'error']),
    summary: BrowserRunSummarySchema,
  })
  .strict();
export type BrowserRunOutput = z.infer<typeof BrowserRunOutputSchema>;

export interface WorkspaceExecInput {
  readonly cmd: string;
  readonly args: string[];
  readonly env?: Record<string, string>;
  readonly timeoutMs: number;
}

export interface WorkspaceExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly terminationReason?: 'timeout';
}

export interface BrowserWorkspaceRequest {
  readonly imageName: 'forge-web-test';
  readonly purpose: 'verifier';
  readonly networkProfile: 'restricted_verification';
  readonly resourceProfile: 'standard';
  readonly organizationId: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly workspaceId: string;
  readonly workspaceCreatedAt: string;
  readonly runId: string;
  readonly taskId: string;
  readonly commitSha: string;
  readonly idempotencyKey: string;
}

export interface BrowserWorkspace {
  readonly imageName: string;
  readonly commitSha: string;
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserWorkspacePort {
  open(request: BrowserWorkspaceRequest): Promise<BrowserWorkspace>;
}

export interface EvidenceObject {
  readonly storageRef: string;
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly contentType: string;
}

export interface EvidenceObjectStore {
  put(object: EvidenceObject): Promise<void>;
}

export interface BrowserRunCompletion {
  readonly leaseStartedAt: Date;
  readonly testRun: NewTestRun;
  readonly artifacts: readonly NewArtifact[];
  readonly testCases: readonly NewTestCase[];
  readonly output: BrowserRunOutput;
}

export interface BrowserRunRecordStore {
  claim(input: BrowserRunInput): Promise<
    | { readonly kind: 'claimed'; readonly leaseStartedAt: Date }
    | { readonly kind: 'replay'; readonly output: BrowserRunOutput }
    | { readonly kind: 'in_progress' }
  >;
  complete(completion: BrowserRunCompletion): Promise<void>;
}

export interface BrowserRunService {
  run(input: BrowserRunInput): Promise<BrowserRunOutput>;
}

export interface EvidenceRedactor {
  redact(text: string): string;
}

const ReporterErrorSchema = z
  .object({
    message: z.string().max(64 * 1024).optional(),
    stack: z.string().max(128 * 1024).optional(),
  })
  .passthrough();
const ReporterAttachmentSchema = z
  .object({
    name: z.string().min(1).max(512),
    contentType: z.string().min(1).max(255),
    path: z.string().max(8_192).optional(),
    body: z.string().max(MAX_EVIDENCE_BYTES * 2).optional(),
  })
  .passthrough();
const ReporterResultSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']),
    duration: z.number().nonnegative().default(0),
    errors: z.array(ReporterErrorSchema).default([]),
    attachments: z.array(ReporterAttachmentSchema).default([]),
  })
  .passthrough();
const ReporterTestSchema = z
  .object({
    projectName: z.string().default(''),
    results: z.array(ReporterResultSchema).min(1),
  })
  .passthrough();
const ReporterSpecSchema = z
  .object({
    title: z.string().min(1).max(2_048),
    file: z.string().max(8_192).default(''),
    line: z.number().int().nonnegative().default(0),
    column: z.number().int().nonnegative().default(0),
    tests: z.array(ReporterTestSchema).min(1),
  })
  .passthrough();

interface ReporterSuite {
  readonly title: string;
  readonly file: string;
  readonly specs: readonly z.infer<typeof ReporterSpecSchema>[];
  readonly suites: readonly ReporterSuite[];
}

const ReporterSuiteSchema: z.ZodType<ReporterSuite, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      title: z.string().max(2_048).default(''),
      file: z.string().max(8_192).default(''),
      specs: z.array(ReporterSpecSchema).default([]),
      suites: z.array(ReporterSuiteSchema).default([]),
    })
    .passthrough(),
);
const ReporterSchema = z
  .object({
    suites: z.array(ReporterSuiteSchema),
    errors: z.array(ReporterErrorSchema).default([]),
  })
  .passthrough();
type ReporterAttachment = z.infer<typeof ReporterAttachmentSchema>;

interface ParsedCase {
  readonly key: string;
  readonly name: string;
  readonly projectName: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly titlePath: readonly string[];
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly durationMs: number;
  readonly retryable: boolean;
  readonly errors: readonly z.infer<typeof ReporterErrorSchema>[];
  readonly attachments: readonly ReporterAttachment[];
}

function errorText(errors: readonly z.infer<typeof ReporterErrorSchema>[]): string {
  return errors.map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`).join('\n');
}

function retryableFailure(status: string, errors: readonly z.infer<typeof ReporterErrorSchema>[]): boolean {
  if (status === 'timedOut') return true;
  return /(?:TimeoutError|page\.goto|navigation|net::ERR_|NS_ERROR_)/iu.test(errorText(errors));
}

function caseKey(input: {
  readonly projectName: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly titlePath: readonly string[];
}): string {
  return JSON.stringify([
    input.projectName,
    input.file,
    input.line,
    input.column,
    ...input.titlePath,
  ]);
}

function flattenReporter(raw: string, truncated: boolean): ParsedCase[] {
  if (truncated || Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error('Playwright JSON report exceeded its boundary');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Playwright did not return a JSON report');
  }
  const report = ReporterSchema.parse(value);
  if (report.errors.length > 0) {
    throw new Error('Playwright reported a suite-level execution error');
  }
  const cases: ParsedCase[] = [];
  const visit = (suite: ReporterSuite, parentTitles: readonly string[]): void => {
    const suiteTitles = suite.title === '' ? parentTitles : [...parentTitles, suite.title];
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        if (test.results.length !== 1) {
          throw new Error('Playwright performed an unexpected internal retry');
        }
        const result = test.results[0];
        if (result === undefined) continue;
        const titlePath = [...suiteTitles, spec.title];
        const identity = {
          projectName: test.projectName,
          file: spec.file === '' ? suite.file : spec.file,
          line: spec.line,
          column: spec.column,
          titlePath,
        };
        const status =
          result.status === 'passed'
            ? 'passed'
            : result.status === 'skipped'
              ? 'skipped'
              : 'failed';
        cases.push({
          key: caseKey(identity),
          name: spec.title,
          ...identity,
          status,
          durationMs: Math.max(0, Math.round(result.duration)),
          retryable: status === 'failed' && retryableFailure(result.status, result.errors),
          errors: result.errors,
          attachments: result.attachments,
        });
      }
    }
    for (const child of suite.suites) visit(child, suiteTitles);
  };
  for (const suite of report.suites) visit(suite, []);
  if (cases.length === 0) throw new Error('Playwright JSON report contained no test cases');
  return cases;
}

function assertExecutionConsistent(
  execution: WorkspaceExecResult,
  cases: readonly ParsedCase[],
): void {
  if (
    execution.terminationReason === 'timeout' ||
    (execution.exitCode !== 0 && !cases.some((testCase) => testCase.status === 'failed'))
  ) {
    throw new Error('Playwright process failed outside a reported test failure');
  }
}

function mergeRetries(initial: readonly ParsedCase[], retry: readonly ParsedCase[]): Array<ParsedCase & { flaky: boolean }> {
  const retryByKey = new Map(retry.map((testCase) => [testCase.key, testCase]));
  return initial.map((testCase) => {
    if (!testCase.retryable) return { ...testCase, flaky: false };
    const retried = retryByKey.get(testCase.key);
    if (retried?.status !== 'passed') {
      return {
        ...(retried ?? testCase),
        durationMs: testCase.durationMs + (retried?.durationMs ?? 0),
        attachments: [...testCase.attachments, ...(retried?.attachments ?? [])],
        flaky: false,
      };
    }
    return {
      ...retried,
      durationMs: testCase.durationMs + retried.durationMs,
      attachments: [...testCase.attachments, ...retried.attachments],
      flaky: true,
    };
  });
}

function generatedConfig(input: BrowserRunInput, outputDir: string): Uint8Array {
  const importLine =
    input.playwrightConfigPath === undefined
      ? ''
      : `import baseConfig from ${JSON.stringify(`./${input.playwrightConfigPath}`)};\n`;
  const base = input.playwrightConfigPath === undefined ? '{}' : 'baseConfig';
  return Buffer.from(
    `${importLine}const base = ${base};\nconst evidenceUse = (projectUse = {}) => ({\n  ...(base.use ?? {}),\n  ...projectUse,\n  baseURL: ${JSON.stringify(input.previewProxyUrl)},\n  trace: 'retain-on-failure',\n  screenshot: 'only-on-failure',\n  video: 'retain-on-failure',\n});\nexport default {\n  ...base,\n  testDir: ${JSON.stringify(`./${input.suitePath}`)},\n  outputDir: ${JSON.stringify(`./${outputDir}`)},\n  retries: 0,\n  workers: 1,\n  use: evidenceUse(),\n  projects: Array.isArray(base.projects)\n    ? base.projects.map((project) => ({\n        ...project,\n        retries: 0,\n        use: evidenceUse(project.use),\n      }))\n    : base.projects,\n};\n`,
    'utf8',
  );
}

function playwrightCommand(configPath: string, selection?: ParsedCase): WorkspaceExecInput {
  if (selection !== undefined && (selection.file === '' || selection.line < 1)) {
    throw new Error('Retryable Playwright case did not include a stable source location');
  }
  return {
    cmd: 'playwright',
    args: [
      'test',
      ...(selection === undefined ? [] : [`${selection.file}:${String(selection.line)}`]),
      `--config=${configPath}`,
      '--reporter=json',
      '--trace=retain-on-failure',
      '--retries=0',
      '--workers=1',
      ...(selection?.projectName === undefined || selection.projectName === ''
        ? []
        : ['--project', selection.projectName]),
    ],
    env: { CI: '1' },
    timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
  };
}

function attachmentPath(rawPath: string, outputDirs: readonly string[]): string {
  const normalized = rawPath.replaceAll('\\', '/');
  for (const outputDir of outputDirs) {
    const marker = `/${outputDir}/`;
    const relative = normalized.startsWith(`${outputDir}/`)
      ? normalized
      : normalized.includes(marker)
        ? normalized.slice(normalized.lastIndexOf(marker) + 1)
        : '';
    if (relative !== '' && !relative.split('/').includes('..')) return relative;
  }
  throw new Error('Playwright attachment escaped the owned evidence directory');
}

function artifactType(attachment: ReporterAttachment): 'playwright_screenshot' | 'playwright_trace' | 'playwright_video' | 'playwright_attachment' {
  const key = `${attachment.name} ${attachment.contentType} ${attachment.path ?? ''}`;
  if (/screenshot|image\//iu.test(key)) return 'playwright_screenshot';
  if (/trace|\.zip$/iu.test(key)) return 'playwright_trace';
  if (/video|webm/iu.test(key)) return 'playwright_video';
  return 'playwright_attachment';
}

function safeError(
  errors: readonly z.infer<typeof ReporterErrorSchema>[],
  redactor: EvidenceRedactor,
): Record<string, unknown> | null {
  if (errors.length === 0) return null;
  return {
    messages: errors.slice(0, 10).map((error) => ({
      message: redactor.redact(error.message ?? 'Playwright failure').slice(0, 16_384),
      stack:
        error.stack === undefined
          ? undefined
          : redactor.redact(error.stack).slice(0, 32_768),
    })),
  };
}

function isTextEvidence(contentType: string): boolean {
  return /^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript))/iu.test(
    contentType,
  );
}

function redactEvidenceBody(
  body: Uint8Array,
  contentType: string,
  redactor: EvidenceRedactor,
): Uint8Array {
  if (!isTextEvidence(contentType)) return body;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  return new TextEncoder().encode(redactor.redact(text));
}

interface EvidenceAttempt {
  readonly kind: 'initial' | 'retry';
  readonly caseKey?: string;
  readonly rawReport: string;
}

function canonicalReport(
  attempts: readonly EvidenceAttempt[],
  redactor: EvidenceRedactor,
): Uint8Array {
  const document = {
    attempts: attempts.map((attempt) => ({
      kind: attempt.kind,
      ...(attempt.caseKey === undefined ? {} : { caseKey: attempt.caseKey }),
      report: JSON.parse(attempt.rawReport) as unknown,
    })),
  };
  const redacted = redactor.redact(JSON.stringify(document));
  JSON.parse(redacted);
  return Buffer.from(redacted, 'utf8');
}

function redactedLabel(value: string, redactor: EvidenceRedactor): string {
  const redacted = redactor.redact(value).slice(0, 2_048);
  return redacted === '' ? '[redacted test]' : redacted;
}

function storageRef(input: BrowserRunInput, artifactId: string, filename: string): string {
  return `org/${input.organizationId}/project/${input.projectId}/run/${input.runId}/test/${input.testRunId}/${artifactId}/${filename}`;
}

async function evidenceForCases(
  input: BrowserRunInput,
  workspace: BrowserWorkspace,
  objects: EvidenceObjectStore,
  outputDirs: readonly string[],
  attempts: readonly EvidenceAttempt[],
  cases: readonly (ParsedCase & { flaky: boolean })[],
  redactor: EvidenceRedactor,
): Promise<{
  artifacts: NewArtifact[];
  testCases: NewTestCase[];
  caseSummaries: z.infer<typeof BrowserCaseSummarySchema>[];
}> {
  const artifactsRows: NewArtifact[] = [];
  const caseRows: NewTestCase[] = [];
  const caseSummaries: z.infer<typeof BrowserCaseSummarySchema>[] = [];
  const store = async (
    type: NewArtifact['type'],
    filename: string,
    contentType: string,
    body: Uint8Array,
    metadataJson: Record<string, unknown>,
  ): Promise<NewArtifact> => {
    const safeBody = redactEvidenceBody(body, contentType, redactor);
    if (safeBody.byteLength > MAX_EVIDENCE_BYTES) {
      throw new Error('Playwright evidence exceeded its boundary');
    }
    const id = newId('art');
    const object: EvidenceObject = {
      storageRef: storageRef(input, id, filename),
      body: safeBody,
      contentHash: createHash('sha256').update(safeBody).digest('hex'),
      contentType,
    };
    await objects.put(object);
    const row: NewArtifact = {
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      type,
      storageRef: object.storageRef,
      contentHash: object.contentHash,
      metadataJson,
    };
    artifactsRows.push(row);
    return row;
  };

  await store(
    'playwright_json_report',
    'report.json',
    'application/json',
    canonicalReport(attempts, redactor),
    {
      testRunId: input.testRunId,
      attempts: attempts.length,
      secretScanEvidenceArtifactId: input.secretScan.evidenceArtifactId,
    },
  );

  for (const testCase of cases) {
    const testCaseId = newId('tcase');
    const evidenceIds: string[] = [];
    let linkedEvidenceId: string | null = null;
    for (const attachment of testCase.attachments) {
      const path =
        attachment.path === undefined
          ? undefined
          : attachmentPath(attachment.path, outputDirs);
      const body =
        attachment.body === undefined
          ? path === undefined
            ? undefined
            : await workspace.readFile(path)
          : Buffer.from(attachment.body, 'base64');
      if (body === undefined) continue;
      const type = artifactType(attachment);
      const filename = posix
        .basename(path ?? `${redactor.redact(attachment.name)}.bin`)
        .replace(/[^A-Za-z0-9._-]/gu, '_');
      const artifact = await store(type, filename, attachment.contentType, body, {
        testRunId: input.testRunId,
        testCaseId,
        attachmentName: redactor.redact(attachment.name),
        secretScanEvidenceArtifactId: input.secretScan.evidenceArtifactId,
      });
      evidenceIds.push(artifact.id);
      if (linkedEvidenceId === null || type === 'playwright_screenshot') linkedEvidenceId = artifact.id;
    }
    caseRows.push({
      id: testCaseId,
      organizationId: input.organizationId,
      testRunId: input.testRunId,
      name: redactedLabel(testCase.name, redactor),
      status: testCase.status,
      durationMs: testCase.durationMs,
      evidenceArtifactId: linkedEvidenceId,
      errorJson: testCase.status === 'failed' ? safeError(testCase.errors, redactor) : null,
    });
    caseSummaries.push({
      testCaseId,
      name: redactedLabel(testCase.name, redactor),
      status: testCase.status,
      durationMs: testCase.durationMs,
      flaky: testCase.flaky,
      evidenceArtifactIds: evidenceIds,
    });
  }
  return { artifacts: artifactsRows, testCases: caseRows, caseSummaries };
}

function outputFromCases(
  testRunId: string,
  durationMs: number,
  artifactsRows: readonly NewArtifact[],
  caseSummaries: readonly z.infer<typeof BrowserCaseSummarySchema>[],
): BrowserRunOutput {
  const passed = caseSummaries.filter((testCase) => testCase.status === 'passed').length;
  const failed = caseSummaries.filter((testCase) => testCase.status === 'failed').length;
  const skipped = caseSummaries.filter((testCase) => testCase.status === 'skipped').length;
  const flaky = caseSummaries.filter((testCase) => testCase.flaky).length;
  return BrowserRunOutputSchema.parse({
    testRunId,
    status: failed === 0 ? 'passed' : 'failed',
    summary: {
      total: caseSummaries.length,
      passed,
      failed,
      skipped,
      flaky,
      durationMs,
      evidenceArtifactIds: artifactsRows.map((artifact) => artifact.id),
      cases: caseSummaries,
    },
  });
}

function errorOutput(testRunId: string, durationMs: number): BrowserRunOutput {
  return {
    testRunId,
    status: 'error',
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
      durationMs,
      evidenceArtifactIds: [],
      cases: [],
      errorCode: 'browser_run_failed',
    },
  };
}

export function createPlaywrightBrowserRunner(deps: {
  readonly workspaces: BrowserWorkspacePort;
  readonly records: BrowserRunRecordStore;
  readonly objects: EvidenceObjectStore;
  readonly redactor: EvidenceRedactor;
  readonly now?: () => Date;
}): BrowserRunService {
  const now = deps.now ?? (() => new Date());
  return {
    async run(value) {
      const input = BrowserRunInputSchema.parse(value);
      const claim = await deps.records.claim(input);
      if (claim.kind === 'replay') return BrowserRunOutputSchema.parse(claim.output);
      if (claim.kind === 'in_progress') throw new Error('Browser run is already in progress');

      const startedAt = claim.leaseStartedAt;
      const configPath = `.zapp-playwright-${input.testRunId}.config.mjs`;
      const outputDir = `.zapp/playwright-${input.testRunId}`;
      const configPaths = [configPath];
      const outputDirs = [outputDir];
      let workspace: BrowserWorkspace | undefined;
      let completion: BrowserRunCompletion;
      let cleanupFailed = false;
      try {
        workspace = await deps.workspaces.open({
          imageName: 'forge-web-test',
          purpose: 'verifier',
          networkProfile: 'restricted_verification',
          resourceProfile: 'standard',
          organizationId: input.organizationId,
          projectId: input.projectId,
          branchId: input.branchId,
          branchName: input.branchName,
          workspaceId: input.workspaceId,
          workspaceCreatedAt: input.workspaceCreatedAt,
          runId: input.runId,
          taskId: input.taskId,
          commitSha: input.commitSha,
          idempotencyKey: input.idempotencyKey,
        });
        if (workspace.imageName !== 'forge-web-test' || workspace.commitSha !== input.commitSha) {
          throw new Error('Browser workspace did not match the locked image and commit');
        }
        await workspace.writeFile(configPath, generatedConfig(input, outputDir));
        const initialExecution = await workspace.exec(playwrightCommand(configPath));
        const initialCases = flattenReporter(initialExecution.stdout, initialExecution.truncated);
        assertExecutionConsistent(initialExecution, initialCases);
        const attempts: EvidenceAttempt[] = [
          { kind: 'initial', rawReport: initialExecution.stdout },
        ];
        let cases: Array<ParsedCase & { flaky: boolean }> = initialCases.map((testCase) => ({
          ...testCase,
          flaky: false,
        }));
        let durationMs = initialExecution.durationMs;
        const retryResults: ParsedCase[] = [];
        for (const [index, retryTarget] of initialCases
          .filter((testCase) => testCase.retryable)
          .entries()) {
          const retryConfigPath = `.zapp-playwright-${input.testRunId}.retry-${String(index)}.config.mjs`;
          const retryOutputDir = `${outputDir}/retry-${String(index)}`;
          configPaths.push(retryConfigPath);
          outputDirs.push(retryOutputDir);
          await workspace.writeFile(retryConfigPath, generatedConfig(input, retryOutputDir));
          const retryExecution = await workspace.exec(
            playwrightCommand(retryConfigPath, retryTarget),
          );
          const parsedRetryCases = flattenReporter(
            retryExecution.stdout,
            retryExecution.truncated,
          );
          assertExecutionConsistent(retryExecution, parsedRetryCases);
          const retried = parsedRetryCases[0];
          if (
            parsedRetryCases.length !== 1 ||
            retried === undefined ||
            retried.key !== retryTarget.key
          ) {
            throw new Error('Playwright retry did not return the selected test case');
          }
          retryResults.push(retried);
          attempts.push({
            kind: 'retry',
            caseKey: retryTarget.key,
            rawReport: retryExecution.stdout,
          });
          durationMs += retryExecution.durationMs;
        }
        cases = mergeRetries(initialCases, retryResults);
        const evidence = await evidenceForCases(
          input,
          workspace,
          deps.objects,
          outputDirs,
          attempts,
          cases,
          deps.redactor,
        );
        const output = outputFromCases(
          input.testRunId,
          durationMs,
          evidence.artifacts,
          evidence.caseSummaries,
        );
        completion = {
          leaseStartedAt: startedAt,
          testRun: {
            id: input.testRunId,
            organizationId: input.organizationId,
            runId: input.runId,
            taskId: input.taskId,
            commitSha: input.commitSha,
            type: 'browser',
            status: output.status,
            startedAt,
            completedAt: now(),
            summaryJson: output.summary,
          },
          artifacts: evidence.artifacts,
          testCases: evidence.testCases,
          output,
        };
      } catch {
        const output = errorOutput(input.testRunId, Math.max(0, now().getTime() - startedAt.getTime()));
        completion = {
          leaseStartedAt: startedAt,
          testRun: {
            id: input.testRunId,
            organizationId: input.organizationId,
            runId: input.runId,
            taskId: input.taskId,
            commitSha: input.commitSha,
            type: 'browser',
            status: output.status,
            startedAt,
            completedAt: now(),
            summaryJson: output.summary,
          },
          artifacts: [],
          testCases: [],
          output,
        };
      } finally {
        if (workspace !== undefined) {
          const ownedWorkspace = workspace;
          await Promise.all(
            configPaths.map(async (path) => {
              await ownedWorkspace.deleteFile(path).catch(() => undefined);
            }),
          );
          const closed = await ownedWorkspace.close().then(
            () => true,
            () => false,
          );
          cleanupFailed = !closed;
        }
      }
      if (cleanupFailed) {
        const output = errorOutput(
          input.testRunId,
          Math.max(0, now().getTime() - startedAt.getTime()),
        );
        completion = {
          leaseStartedAt: startedAt,
          testRun: {
            id: input.testRunId,
            organizationId: input.organizationId,
            runId: input.runId,
            taskId: input.taskId,
            commitSha: input.commitSha,
            type: 'browser',
            status: output.status,
            startedAt,
            completedAt: now(),
            summaryJson: output.summary,
          },
          artifacts: [],
          testCases: [],
          output,
        };
      }
      await deps.records.complete(completion);
      return completion.output;
    },
  };
}

export function createDrizzleBrowserRunRecordStore(
  db: Database,
  now: () => Date = () => new Date(),
): BrowserRunRecordStore {
  return {
    async claim(input) {
      const claimedAt = now();
      const [scope] = await db
        .select({ runId: agentRuns.id })
        .from(agentRuns)
        .innerJoin(
          agentPhases,
          and(
            eq(agentPhases.runId, agentRuns.id),
            eq(agentPhases.organizationId, input.organizationId),
          ),
        )
        .innerJoin(
          agentTasks,
          and(
            eq(agentTasks.id, input.taskId),
            eq(agentTasks.phaseId, agentPhases.id),
            eq(agentTasks.organizationId, input.organizationId),
          ),
        )
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.organizationId, input.organizationId),
            eq(agentRuns.projectId, input.projectId),
            eq(agentRuns.branchId, input.branchId),
          ),
        )
        .limit(1);
      if (scope === undefined) {
        throw new Error('Browser run scope does not own its run, branch, and task');
      }
      const inserted = await db
        .insert(testRuns)
        .values({
          id: input.testRunId,
          organizationId: input.organizationId,
          runId: input.runId,
          taskId: input.taskId,
          commitSha: input.commitSha,
          type: 'browser',
          status: 'running',
          startedAt: claimedAt,
          completedAt: null,
          summaryJson: null,
        })
        .onConflictDoNothing({ target: testRuns.id })
        .returning({ id: testRuns.id });
      if (inserted.length === 1) return { kind: 'claimed', leaseStartedAt: claimedAt };
      const [existing] = await db
        .select()
        .from(testRuns)
        .where(
          and(
            eq(testRuns.id, input.testRunId),
            eq(testRuns.organizationId, input.organizationId),
          ),
        )
        .limit(1);
      if (
        existing === undefined ||
        existing.runId !== input.runId ||
        existing.taskId !== input.taskId ||
        existing.commitSha !== input.commitSha ||
        existing.type !== 'browser'
      ) {
        throw new Error('Browser run key conflicts with an existing test run');
      }
      if (existing.completedAt !== null && existing.summaryJson !== null) {
        return {
          kind: 'replay',
          output: BrowserRunOutputSchema.parse({
            testRunId: existing.id,
            status: existing.status,
            summary: existing.summaryJson,
          }),
        };
      }
      if (existing.completedAt !== null || existing.summaryJson !== null) {
        throw new Error('Browser run has an inconsistent completion record');
      }
      if (!browserRunLeaseExpired(existing.startedAt, claimedAt)) {
        return { kind: 'in_progress' };
      }
      const reclaimed = await db
        .update(testRuns)
        .set({ startedAt: claimedAt })
        .where(
          and(
            eq(testRuns.id, input.testRunId),
            eq(testRuns.organizationId, input.organizationId),
            eq(testRuns.status, 'running'),
            eq(testRuns.startedAt, existing.startedAt),
            isNull(testRuns.completedAt),
          ),
        )
        .returning({ id: testRuns.id });
      return reclaimed.length === 1
        ? { kind: 'claimed', leaseStartedAt: claimedAt }
        : { kind: 'in_progress' };
    },
    async complete(completion) {
      if (!(completion.testRun.completedAt instanceof Date)) {
        throw new Error('Browser run completion requires a completion time');
      }
      const completedAt = completion.testRun.completedAt;
      await db.transaction(async (tx) => {
        if (completion.artifacts.length > 0) {
          await tx.insert(artifacts).values([...completion.artifacts]);
          await tx
            .insert(artifactRetention)
            .values(classifyTestArtifacts(completion.artifacts, completedAt));
        }
        if (completion.testCases.length > 0) await tx.insert(testCases).values([...completion.testCases]);
        const updated = await tx
          .update(testRuns)
          .set({
            status: completion.output.status,
            completedAt: completion.testRun.completedAt,
            summaryJson: completion.output.summary,
          })
          .where(
            and(
              eq(testRuns.id, completion.output.testRunId),
              eq(testRuns.organizationId, completion.testRun.organizationId),
              eq(testRuns.status, 'running'),
              eq(testRuns.startedAt, completion.leaseStartedAt),
              isNull(testRuns.completedAt),
            ),
          )
          .returning({ id: testRuns.id });
        if (updated.length !== 1) throw new Error('Browser run completion lost its claim');
      });
    },
  };
}

export interface EvidenceObjectClient {
  send(command: PutObjectCommand): Promise<unknown>;
}

export function createR2EvidenceObjectStore(options: {
  readonly client: EvidenceObjectClient;
  readonly bucket: string;
}): EvidenceObjectStore {
  const bucket = z.string().trim().min(3).max(255).parse(options.bucket);
  return {
    async put(object) {
      await options.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: object.storageRef,
          Body: object.body,
          ContentType: object.contentType,
          Metadata: { sha256: object.contentHash },
        }),
      );
    },
  };
}

export function createEvidenceObjectClient(config: S3ClientConfig): S3Client {
  return new S3Client(config);
}
