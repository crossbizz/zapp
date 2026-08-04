import { z } from 'zod';
import type { ExecutionContract } from './execution-contract.js';

/**
 * Read-only view of a project's files. Plan 05 (VF-1) implements it over the
 * workspace runtime, so detection behaves the same locally and in a sandbox.
 */
export interface DetectionContext {
  /** Directory every path below is relative to. */
  readonly workspaceRoot: string;
  /** Paths matching a glob, relative to `workspaceRoot`; empty when nothing matches. */
  listFiles(glob: string): Promise<string[]>;
  /** UTF-8 contents of one file; rejects when the file is absent. */
  readFile(path: string): Promise<string>;
}

/**
 * One adapter's verdict on a project (plan 05 VF-1 ranks these). Confidence 0 means
 * "not my project"; the generic Node fallback always scores above 0.
 */
export const DetectionResultSchema = z.object({
  adapterId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  /** Why it matched, in files and markers — shown in the scan report card (PRD §10.2). */
  evidence: z.array(z.string().min(1)),
});

export type DetectionResult = z.infer<typeof DetectionResultSchema>;

/** The winning adapter's working context: the same file access plus its own detection. */
export interface ProjectContext extends DetectionContext {
  readonly detection: DetectionResult;
}

/**
 * A route the browser gates can visit (plan 05 VF-6 caps and prioritises them).
 * `api` routes are discovered too, but only `page` routes are browsed.
 */
export const RouteSchema = z.object({
  /** As the framework declares it, dynamic segments included: `/projects/[id]`. */
  path: z.string().min(1),
  kind: z.enum(['page', 'api']),
  dynamic: z.boolean(),
  /** File the route came from, relative to the workspace root. */
  sourceFile: z.string().min(1),
});

export type Route = z.infer<typeof RouteSchema>;

/** One test the adapter thinks the project should have (plan 05 VF-8 writes it). */
export const ProposedTestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['unit', 'integration', 'browser']),
  title: z.string().min(1),
  /** File the test would be written to, relative to the workspace root. */
  targetPath: z.string().min(1),
  rationale: z.string().min(1),
});

export type ProposedTest = z.infer<typeof ProposedTestSchema>;

/** A proposal, not a result: the runners themselves come from the execution contract. */
export const TestPlanSchema = z.object({
  tests: z.array(ProposedTestSchema),
});

export type TestPlan = z.infer<typeof TestPlanSchema>;

/** Telemetry capabilities plan 10 (OPS-6) can install into a generated app (PRD §29.2). */
export const InstrumentationCapabilitySchema = z.enum([
  'frontend_errors',
  'backend_tracing',
  'structured_logging',
  'health_endpoint',
  'analytics',
]);

export type InstrumentationCapability = z.infer<typeof InstrumentationCapabilitySchema>;

export const InstrumentationStepSchema = z.object({
  id: z.string().min(1),
  capability: InstrumentationCapabilitySchema,
  /** File the step would create or edit, relative to the workspace root. */
  targetPath: z.string().min(1),
  rationale: z.string().min(1),
  /** True when the project already has this capability — detected, not assumed (PRD §17.1). */
  alreadyPresent: z.boolean(),
});

export type InstrumentationStep = z.infer<typeof InstrumentationStepSchema>;

export const InstrumentationPlanSchema = z.object({
  steps: z.array(InstrumentationStepSchema),
});

export type InstrumentationPlan = z.infer<typeof InstrumentationPlanSchema>;

/**
 * Which deployment provider suits the project (plan 07 uses it as a hint, then
 * confirms with the provider's own `detectCompatibility`).
 */
export const DeploymentPlanSchema = z.object({
  /** Id of a provider registered in plan 07 (`vercel`, `fly`), kept open for later adapters. */
  providerId: z.string().min(1),
  rationale: z.string().min(1),
  /** Environment variable names the app needs in production — names only, never values (PRD §18.12). */
  requiredEnvVars: z.array(z.string().min(1)),
});

export type DeploymentPlan = z.infer<typeof DeploymentPlanSchema>;

/**
 * PRD §17.3, verbatim. Implemented per framework in plan 05's `project-adapters`
 * package, with generic Node.js always available as the fallback.
 */
export interface ProjectAdapter {
  readonly id: string;
  detect(ctx: DetectionContext): Promise<DetectionResult>;
  deriveExecutionContract(ctx: ProjectContext): Promise<ExecutionContract>;
  discoverRoutes(ctx: ProjectContext): Promise<Route[]>;
  proposeTests(ctx: ProjectContext): Promise<TestPlan>;
  proposeInstrumentation(ctx: ProjectContext): Promise<InstrumentationPlan>;
  /** Null when the adapter has no opinion — the user picks a provider instead. */
  proposeDeployment(ctx: ProjectContext): Promise<DeploymentPlan | null>;
}
