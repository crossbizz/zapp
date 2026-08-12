import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommitShaSchema } from '@zapp/contracts';
import { z } from 'zod';

import { createGitCommandRunner, type GitCommandRunner } from './import/git.js';

const SafeSourceUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' || url.hostname !== 'github.com' ||
    url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
  ) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid approved template source' });
});
const SeedInputSchema = z.object({
  sourceCloneUrl: SafeSourceUrlSchema,
  sourceCommitSha: CommitShaSchema,
  targetCloneUrl: z.string().url().refine((value) => value.startsWith('https://')),
  targetUsername: z.string().min(1),
  targetToken: z.string().min(1),
  targetBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u),
}).strict();
export type GitTemplateSeedInput = z.infer<typeof SeedInputSchema>;

export interface GitTemplateSeeder {
  seed(input: GitTemplateSeedInput): Promise<{ readonly headCommitSha: string }>;
}

export class GitTemplateSeedConflictError extends Error {
  constructor() {
    super('Target repository contains different history');
    this.name = 'GitTemplateSeedConflictError';
  }
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$ZAPP_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZAPP_GIT_PASSWORD" ;;
esac
`;

export function createGitTemplateSeeder(options: {
  readonly runner?: GitCommandRunner;
  readonly timeoutMs?: number;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
} = {}): GitTemplateSeeder {
  const runner = options.runner ?? createGitCommandRunner();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const createTemporaryDirectory = options.createTemporaryDirectory ??
    (() => mkdtemp(join(tmpdir(), 'zapp-template-seed-')));
  const removeTemporaryDirectory = options.removeTemporaryDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));

  return {
    async seed(rawInput) {
      const input = SeedInputSchema.parse(rawInput);
      const directory = await createTemporaryDirectory();
      const repository = join(directory, 'repository');
      const askpass = join(directory, 'target-askpass.sh');
      const baseEnv = {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      } as const;
      const targetEnv = {
        ...baseEnv,
        GIT_ASKPASS: askpass,
        ZAPP_GIT_USERNAME: input.targetUsername,
        ZAPP_GIT_PASSWORD: input.targetToken,
      };
      try {
        await writeFile(askpass, ASKPASS, { mode: 0o700 });
        await chmod(askpass, 0o700);
        await runner.run({ args: ['init', '--quiet', '--initial-branch=main', repository], env: baseEnv, timeoutMs });
        await runner.run({ args: ['remote', 'add', 'source', input.sourceCloneUrl], cwd: repository, env: baseEnv, timeoutMs });
        await runner.run({ args: ['fetch', '--depth=1', 'source', input.sourceCommitSha], cwd: repository, env: baseEnv, timeoutMs });
        await runner.run({ args: ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], cwd: repository, env: baseEnv, timeoutMs });
        const resolved = CommitShaSchema.parse((await runner.run({
          args: ['rev-parse', 'HEAD'], cwd: repository, env: baseEnv, timeoutMs,
        })).stdout.trim());
        if (resolved !== input.sourceCommitSha) throw new Error('Template source identity mismatch');
        await runner.run({ args: ['remote', 'add', 'target', input.targetCloneUrl], cwd: repository, env: baseEnv, timeoutMs });
        const remote = (await runner.run({
          args: ['ls-remote', 'target'], cwd: repository, env: targetEnv, timeoutMs,
        })).stdout.trim();
        if (remote === '') {
          await runner.run({
            args: ['push', 'target', `HEAD:refs/heads/${input.targetBranch}`],
            cwd: repository, env: targetEnv, timeoutMs,
          });
          return { headCommitSha: resolved };
        }
        const rows = remote.split('\n').map((row) => row.trim().split(/\s+/u));
        const allowed = new Set(['HEAD', `refs/heads/${input.targetBranch}`]);
        if (
          rows.some(([sha, ref, ...rest]) =>
            rest.length !== 0 || !CommitShaSchema.safeParse(sha).success ||
            ref === undefined || !allowed.has(ref) || sha !== resolved,
          ) || !rows.some(([, ref]) => ref === `refs/heads/${input.targetBranch}`)
        ) throw new GitTemplateSeedConflictError();
        return { headCommitSha: resolved };
      } finally {
        await removeTemporaryDirectory(directory);
      }
    },
  };
}
