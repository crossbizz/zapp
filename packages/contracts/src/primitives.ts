import { z } from 'zod';

// Leaf schemas shared by more than one contract module. They live here so a rule
// that applies everywhere — https only, secrets are strings, a sha is resolved —
// has exactly one definition to read, test and change.

/**
 * Provider-issued URL. https only: preview and deployed traffic is never plaintext.
 */
export const HttpsUrlSchema = z.string().url().startsWith('https://', 'URL must use https');

/**
 * Environment handed to a workspace or a deployment. Values are secret material:
 * only allowlisted services hold them, and they are never logged, echoed into
 * events, or shown to an agent (PRD §18.12).
 */
export const EnvVarsSchema = z.record(z.string());

export type EnvVars = z.infer<typeof EnvVarsSchema>;

/** Exactly 40 lowercase hex characters: a resolved git commit, never a ref. */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'Invalid commit sha');

/**
 * The control plane's own `environments` row identifier. Environments have had an
 * `env_` prefix since FND-6; this stays a plain string because provider adapters
 * (plan 07) also address environments the provider named, and narrowing it to
 * `idSchema('env')` is plan 07's call to make with its provider registry.
 */
export const EnvironmentIdSchema = z.string().min(1);

/**
 * A path on this application. Rooted, and not protocol-relative: `//host/x` is a URL
 * to another origin, which must never be probed as if it were the project's own.
 */
export const AppPathSchema = z.string().regex(/^\/(?!\/)/, 'Path must start with a single /');
