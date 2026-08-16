import {
  DetectionResultSchema,
  ExecutionContractSchema,
  idSchema,
  type DetectionContext,
  type ProjectAdapter,
  type ProjectContext,
} from '@zapp/contracts';
import { z } from 'zod';

import { detectProject } from './detect.js';
import { frameworkAdapters } from './frameworks.js';
import { genericNodeAdapter } from './generic-node.js';

const EvidenceCapabilitySchema = z
  .object({
    provider: z.string().min(1),
    evidence: z.array(z.string().min(1)).min(1),
  })
  .strict();

const TestCapabilitiesSchema = z
  .object({
    unit: z.boolean(),
    integration: z.boolean(),
    browser: z.boolean(),
  })
  .strict();

const ObservabilityProviderSchema = z.enum(['faro', 'otel', 'posthog', 'sentry']);
export const CapabilityScanIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,255}$/u);
const CapabilityScanActivityIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^capability-scan:org_[0-9A-HJKMNP-TV-Z]{26}:proj_[0-9A-HJKMNP-TV-Z]{26}:/u);

export const CapabilityScanResultSchema = z
  .object({
    supportLevel: z.literal('compatible'),
    verifiedEligible: z.boolean(),
    detectedFramework: z.string().min(1).nullable(),
    detections: z.array(DetectionResultSchema).min(1),
    contract: ExecutionContractSchema,
    database: EvidenceCapabilitySchema.nullable(),
    auth: EvidenceCapabilitySchema.nullable(),
    deployment: EvidenceCapabilitySchema.nullable(),
    tests: TestCapabilitiesSchema,
    observability: z.array(ObservabilityProviderSchema),
    reportCard: z
      .object({
        evidence: z.array(z.string().min(1)),
        missingCapabilities: z.array(z.string().min(1)),
        hardenProjectInput: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type CapabilityScanResult = z.infer<typeof CapabilityScanResultSchema>;

export const CapabilityScanArtifactMetadataSchema = CapabilityScanResultSchema.pick({
  verifiedEligible: true,
  database: true,
  auth: true,
  deployment: true,
  tests: true,
  observability: true,
  reportCard: true,
})
  .extend({
    scanId: CapabilityScanIdSchema,
    contractId: idSchema('pc'),
  })
  .strict();

export function capabilityScanActivityIdempotencyKey(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly scanId: string;
}): string {
  const parsed = z
    .object({
      organizationId: idSchema('org'),
      projectId: idSchema('proj'),
      scanId: CapabilityScanIdSchema,
    })
    .strict()
    .parse(input);
  return CapabilityScanActivityIdempotencyKeySchema.parse(
    `capability-scan:${parsed.organizationId}:${parsed.projectId}:${parsed.scanId}`,
  );
}

export const CapabilityScanInputSchema = z
  .object({
    scanId: CapabilityScanIdSchema,
    idempotencyKey: CapabilityScanActivityIdempotencyKeySchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    branchId: idSchema('br'),
    branchName: z.string().trim().min(1).max(255),
    workspaceId: idSchema('ws'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    workspaceCreatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.idempotencyKey !==
      capabilityScanActivityIdempotencyKey({
        organizationId: input.organizationId,
        projectId: input.projectId,
        scanId: input.scanId,
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['idempotencyKey'],
        message: 'Capability scan activity key does not match its tenant scope',
      });
    }
  });

export const CapabilityScanOutputSchema = z
  .object({
    result: CapabilityScanResultSchema,
    reportArtifact: z
      .object({
        storageRef: z.string().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
  })
  .strict();

export type CapabilityScanInput = z.infer<typeof CapabilityScanInputSchema>;
export type CapabilityScanOutput = z.infer<typeof CapabilityScanOutputSchema>;

export function capabilityScanArtifactStorageRef(input: CapabilityScanInput): string {
  const parsed = CapabilityScanInputSchema.parse(input);
  return `org/${parsed.organizationId}/project/${parsed.projectId}/capability-scan/${parsed.scanId}.json`;
}

/** Client proxy for the Temporal activity that owns the scan workspace. */
export interface CapabilityScanPort {
  scan(input: CapabilityScanInput): Promise<CapabilityScanOutput>;
}

export class CapabilityScanUnavailableError extends Error {
  constructor() {
    super('capability scan unavailable');
    this.name = 'CapabilityScanUnavailableError';
  }
}

export function createUnavailableCapabilityScanPort(): CapabilityScanPort {
  return { scan: () => Promise.reject(new CapabilityScanUnavailableError()) };
}

const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
    scripts: z.record(z.string()).optional(),
  })
  .passthrough();

type PackageJson = z.infer<typeof PackageJsonSchema>;

function normalize(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

const NON_SOURCE_DIRECTORY_NAMES = new Set([
  '.astro',
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

function isProjectSourcePath(path: string): boolean {
  return normalize(path)
    .split('/')
    .every((segment) => !NON_SOURCE_DIRECTORY_NAMES.has(segment));
}

function declaredPackages(manifest: PackageJson): Readonly<Record<string, string>> {
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

function packageEvidence(
  packages: Readonly<Record<string, string>>,
  names: readonly string[],
): string[] {
  return names.filter((name) => name in packages).map((name) => `package.json#${name}`);
}

function sourceEvidence(source: string, tokens: readonly string[]): string[] {
  return tokens.filter((token) => source.includes(token)).map((token) => `source:${token}`);
}

function firstCapability(
  candidates: readonly { readonly provider: string; readonly evidence: readonly string[] }[],
): z.infer<typeof EvidenceCapabilitySchema> | null {
  const match = candidates.find(({ evidence }) => evidence.length > 0);
  return match === undefined
    ? null
    : EvidenceCapabilitySchema.parse({ provider: match.provider, evidence: [...match.evidence] });
}

function detectDatabase(
  files: ReadonlySet<string>,
  packages: Readonly<Record<string, string>>,
  envNames: ReadonlySet<string>,
): z.infer<typeof EvidenceCapabilitySchema> | null {
  return firstCapability([
    {
      provider: 'supabase',
      evidence: [
        ...(files.has('supabase/config.toml') ? ['supabase/config.toml'] : []),
        ...packageEvidence(packages, ['@supabase/supabase-js', '@supabase/ssr']),
        ...(envNames.has('SUPABASE_URL') || envNames.has('NEXT_PUBLIC_SUPABASE_URL')
          ? ['env:SUPABASE_URL']
          : []),
      ],
    },
    {
      provider: 'neon',
      evidence: [
        ...packageEvidence(packages, ['@neondatabase/serverless']),
        ...(envNames.has('NEON_DATABASE_URL') ? ['env:NEON_DATABASE_URL'] : []),
      ],
    },
    {
      provider: 'prisma',
      evidence: [
        ...(files.has('prisma/schema.prisma') ? ['prisma/schema.prisma'] : []),
        ...packageEvidence(packages, ['@prisma/client', 'prisma']),
      ],
    },
    {
      provider: 'drizzle',
      evidence: [
        ...[...files].filter((path) => /^drizzle\.config\.[cm]?[jt]s$/u.test(path)),
        ...packageEvidence(packages, ['drizzle-orm']),
      ],
    },
    {
      provider: 'postgres',
      evidence: envNames.has('DATABASE_URL') ? ['env:DATABASE_URL'] : [],
    },
  ]);
}

function detectAuth(
  packages: Readonly<Record<string, string>>,
  source: string,
): z.infer<typeof EvidenceCapabilitySchema> | null {
  return firstCapability([
    {
      provider: 'supabase',
      evidence: [
        ...packageEvidence(packages, ['@supabase/ssr', '@supabase/auth-helpers-nextjs']),
        ...sourceEvidence(source, ['@supabase/ssr', '@supabase/auth-helpers-nextjs']),
      ],
    },
    {
      provider: 'stytch',
      evidence: [
        ...packageEvidence(packages, ['@stytch/nextjs', '@stytch/vanilla-js', 'stytch']),
        ...sourceEvidence(source, ['@stytch/nextjs', '@stytch/vanilla-js']),
      ],
    },
    {
      provider: 'clerk',
      evidence: [
        ...packageEvidence(packages, ['@clerk/nextjs', '@clerk/clerk-react']),
        ...sourceEvidence(source, ['@clerk/nextjs', '@clerk/clerk-react']),
      ],
    },
    {
      provider: 'auth0',
      evidence: [
        ...packageEvidence(packages, ['@auth0/nextjs-auth0', '@auth0/auth0-react']),
        ...sourceEvidence(source, ['@auth0/nextjs-auth0', '@auth0/auth0-react']),
      ],
    },
    {
      provider: 'authjs',
      evidence: [
        ...packageEvidence(packages, ['next-auth', '@auth/core']),
        ...sourceEvidence(source, ['next-auth', '@auth/core']),
      ],
    },
  ]);
}

function detectDeployment(
  files: ReadonlySet<string>,
  proposedProvider: string | undefined,
): z.infer<typeof EvidenceCapabilitySchema> | null {
  return firstCapability([
    { provider: 'vercel', evidence: files.has('vercel.json') ? ['vercel.json'] : [] },
    { provider: 'fly', evidence: files.has('fly.toml') ? ['fly.toml'] : [] },
    {
      provider: 'container',
      evidence: files.has('Dockerfile') ? ['Dockerfile'] : [],
    },
    {
      provider: proposedProvider ?? 'unknown',
      evidence: proposedProvider === undefined ? [] : [`adapter:${proposedProvider}`],
    },
  ]);
}

function environmentNames(contents: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const content of contents) {
    for (const line of content.split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/u.exec(line);
      if (match?.[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

async function readableContents(
  ctx: DetectionContext,
  paths: readonly string[],
): Promise<string[]> {
  const reads = await Promise.all(
    paths.map(async (path) => {
      try {
        return await ctx.readFile(path);
      } catch {
        return '';
      }
    }),
  );
  return reads.filter((content) => content.length > 0);
}

function testsFrom(
  contract: z.infer<typeof ExecutionContractSchema>,
): z.infer<typeof TestCapabilitiesSchema> {
  return TestCapabilitiesSchema.parse({
    unit: contract.test?.unit !== undefined,
    integration: contract.test?.integration !== undefined,
    browser: contract.test?.browser !== undefined,
  });
}

function missingCapabilities(input: {
  readonly database: unknown;
  readonly auth: unknown;
  readonly deployment: unknown;
  readonly tests: z.infer<typeof TestCapabilitiesSchema>;
  readonly observability: readonly string[];
}): string[] {
  return [
    ...(input.database === null ? ['database'] : []),
    ...(input.auth === null ? ['auth'] : []),
    ...(input.deployment === null ? ['deployment'] : []),
    ...(!input.tests.unit ? ['unit_tests'] : []),
    ...(!input.tests.integration ? ['integration_tests'] : []),
    ...(!input.tests.browser ? ['browser_tests'] : []),
    ...(input.observability.length === 0 ? ['observability'] : []),
  ];
}

/**
 * The deterministic body of VF-3's workspace activity. It reads names and
 * project source only; environment values are neither required nor returned.
 */
export async function scanProjectCapabilities(
  ctx: DetectionContext,
): Promise<CapabilityScanResult> {
  const sourceContext: DetectionContext = {
    ...ctx,
    listFiles: async (glob) => (await ctx.listFiles(glob)).filter(isProjectSourcePath),
  };
  const listed = (await sourceContext.listFiles('**/*')).map(normalize).sort();
  const files = new Set(listed);
  const manifest = PackageJsonSchema.parse(
    JSON.parse(await sourceContext.readFile('package.json')),
  );
  const packages = declaredPackages(manifest);
  const detections = await detectProject(sourceContext);
  const winner = detections.find(({ adapterId }) => adapterId !== 'capacitor') ?? detections[0];
  if (winner === undefined) throw new TypeError('Capability scan found no project adapter');

  const adapters: readonly ProjectAdapter[] = [...frameworkAdapters, genericNodeAdapter];
  const adapter = adapters.find(({ id }) => id === winner.adapterId);
  if (adapter === undefined) throw new TypeError(`Unknown project adapter: ${winner.adapterId}`);
  const projectContext: ProjectContext = { ...sourceContext, detection: winner };
  const baseContract = await adapter.deriveExecutionContract(projectContext);
  const scripts = manifest.scripts ?? {};
  const manager = baseContract.package_manager;
  const command = (name: string): string => `${manager} run ${name}`;
  const contract = ExecutionContractSchema.parse({
    ...baseContract,
    ...(baseContract.test === undefined && scripts.test === undefined
      ? {}
      : {
          test: {
            ...baseContract.test,
            ...(scripts.test === undefined ? {} : { unit: command('test') }),
            ...(scripts['test:integration'] === undefined
              ? {}
              : { integration: command('test:integration') }),
            ...(scripts['test:browser'] === undefined && scripts.e2e === undefined
              ? {}
              : {
                  browser: command(scripts['test:browser'] === undefined ? 'e2e' : 'test:browser'),
                }),
          },
        }),
  });

  const envFiles = listed.filter((path) => /(^|\/)\.env(?:\.[^.]+)?(?:\.example)?$/u.test(path));
  const envNames = environmentNames(await readableContents(sourceContext, envFiles));
  const sourceFiles = listed.filter((path) => /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/u.test(path));
  const source = (await readableContents(sourceContext, sourceFiles)).join('\n');
  const database = detectDatabase(files, packages, envNames);
  const auth = detectAuth(packages, source);
  const proposed = await adapter.proposeDeployment(projectContext);
  const deployment = detectDeployment(files, proposed?.providerId);
  const tests = testsFrom(contract);

  const observability = ObservabilityProviderSchema.options.filter((provider) => {
    const names =
      provider === 'sentry'
        ? ['@sentry/nextjs', '@sentry/node', '@sentry/react']
        : provider === 'faro'
          ? ['@grafana/faro-web-sdk']
          : provider === 'otel'
            ? ['@opentelemetry/api', '@opentelemetry/sdk-node']
            : ['posthog-js', 'posthog-node'];
    return packageEvidence(packages, names).length > 0 || sourceEvidence(source, names).length > 0;
  });
  const missing = missingCapabilities({ database, auth, deployment, tests, observability });
  const evidence = [
    ...winner.evidence,
    ...(database?.evidence ?? []),
    ...(auth?.evidence ?? []),
    ...(deployment?.evidence ?? []),
    ...Object.keys(scripts)
      .filter((name) => ['test', 'test:integration', 'test:browser', 'e2e'].includes(name))
      .map((name) => `package.json#scripts.${name}`),
  ];

  return CapabilityScanResultSchema.parse({
    supportLevel: 'compatible',
    verifiedEligible:
      contract.build !== undefined &&
      contract.typecheck !== undefined &&
      contract.test !== undefined,
    detectedFramework: winner.adapterId === 'generic-node' ? null : winner.adapterId,
    detections,
    contract,
    database,
    auth,
    deployment,
    tests,
    observability,
    reportCard: {
      evidence: [...new Set(evidence)].sort(),
      missingCapabilities: missing,
      hardenProjectInput: missing,
    },
  });
}
