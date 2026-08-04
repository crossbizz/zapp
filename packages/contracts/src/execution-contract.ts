import { z } from 'zod';

/** A shell command run in the workspace; empty means "unknown", which is a block, not a no-op. */
const commandSchema = z.string().min(1);

/** Wall-clock budget for a command. Whole seconds, matching the PRD §17.2 YAML. */
const timeoutSecondsSchema = z.number().int().positive();

/** TCP port the dev server or preview target listens on. */
const portSchema = z.number().int().min(1).max(65_535);

/**
 * A path on this application. Rooted, and not protocol-relative: `//host/x` is a URL
 * to another origin, which must never be probed as if it were the project's own.
 */
const appPathSchema = z.string().regex(/^\/(?!\/)/, 'Path must start with a single /');

/** A command block with an optional budget. Strict: a misspelled key is a broken contract, not a comment. */
const timedCommandSchema = z
  .object({
    command: commandSchema,
    timeout_seconds: timeoutSecondsSchema.optional(),
  })
  .strict();

/** PRD §17.1 "Package manager". Detected from the lockfile by plan 05's adapters. */
export const PackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun']);

export type PackageManager = z.infer<typeof PackageManagerSchema>;

/**
 * PRD §17.2. The single description of how to install, run, build, check and test
 * one project — derived once per scan (plan 05 VF-3), stored on `project_contracts`,
 * and read by every sandbox command (plan 03) and verification gate (plan 05).
 *
 * Keys are snake_case because the contract is authored and reviewed as the YAML
 * document in the PRD; this schema parses that document as-is.
 */
export const ExecutionContractSchema = z
  .object({
    /** Schema version of the contract document itself. Only 1 exists in P0. */
    version: z.literal(1),
    package_manager: PackageManagerSchema,
    /** Directory the commands run from, relative to the repository root (`.` for single-package repos). */
    workspace_root: z.string().min(1),
    /** Dependency installation. Required: no project is usable without it. */
    install: timedCommandSchema,
    /** Dev server plus the port the preview proxy targets (plan 03 WS-10/WS-13). */
    develop: z
      .object({
        command: commandSchema,
        port: portSchema,
      })
      .strict(),
    /** Production build. Absent when the project has none — that costs the `verified` support level. */
    build: timedCommandSchema.optional(),
    /**
     * Production start command (PRD §17.1). Distinct from `develop`: this is what the
     * deployed container runs, so plan 07's Fly adapter (DEP-4) templates it into the image.
     */
    start: timedCommandSchema.optional(),
    typecheck: z.object({ command: commandSchema }).strict().optional(),
    lint: z.object({ command: commandSchema }).strict().optional(),
    /** Test entry points the gate engine (plan 05) runs; either may be absent, but not both. */
    test: z
      .object({
        unit: commandSchema.optional(),
        browser: commandSchema.optional(),
      })
      .strict()
      .refine((t) => t.unit !== undefined || t.browser !== undefined, {
        message: 'test must declare a unit or browser command',
      })
      .optional(),
    /** Path probed for readiness and for the pre-deployment health gate (plan 07 DEP-7). */
    health: z.object({ path: appPathSchema }).strict().optional(),
  })
  .strict();

export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;
