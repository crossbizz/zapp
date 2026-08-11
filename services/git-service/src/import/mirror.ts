import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommitShaSchema } from '@zapp/contracts';
import { z } from 'zod';

import { createGitCommandRunner, type GitCommandRunner } from './git.js';

const MirrorInputSchema = z
  .object({
    sourceCloneUrl: z.string().min(1),
    sourceToken: z.string().min(1),
    sourceBranch: z.string().trim().min(1).max(255),
    targetCloneUrl: z.string().min(1),
    targetUsername: z.string().min(1),
    targetToken: z.string().min(1),
  })
  .strict();

export type GitMirrorInput = z.infer<typeof MirrorInputSchema>;

export class GitMirrorError extends Error {
  constructor() {
    super('git mirror failed');
    this.name = 'GitMirrorError';
  }
}

export class GitMirrorConflictError extends Error {
  constructor() {
    super('target branch already exists at a different commit');
    this.name = 'GitMirrorConflictError';
  }
}

export interface GitMirror {
  mirror(input: GitMirrorInput): Promise<{ headCommitSha: string }>;
}

interface GitMirrorOptions {
  readonly runner?: GitCommandRunner;
  readonly timeoutMs?: number;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$ZAPP_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZAPP_GIT_PASSWORD" ;;
esac
`;

const RemoteRefSchema = z
  .object({
    sha: CommitShaSchema,
    ref: z.string().min(1),
  })
  .strict();

function targetState(
  stdout: string,
  branch: string,
  sourceHead: string,
): 'empty' | 'equal' | 'conflict' {
  const lines = stdout.trim() === '' ? [] : stdout.trim().split('\n');
  if (lines.length === 0) return 'empty';

  const refs = lines.map((line) => {
    const [sha, ref, ...rest] = line.trim().split(/\s+/u);
    if (rest.length !== 0) throw new GitMirrorError();
    return RemoteRefSchema.parse({ sha, ref });
  });
  const expectedRef = `refs/heads/${branch}`;
  const selected = refs.filter((entry) => entry.ref === expectedRef);
  const unrelated = refs.filter((entry) => entry.ref !== expectedRef && entry.ref !== 'HEAD');
  const divergentHead = refs.some((entry) => entry.ref === 'HEAD' && entry.sha !== sourceHead);
  if (
    selected.length !== 1 ||
    selected[0]?.sha !== sourceHead ||
    unrelated.length !== 0 ||
    divergentHead
  ) {
    return 'conflict';
  }
  return 'equal';
}

export function createGitMirror(options: GitMirrorOptions = {}): GitMirror {
  const runner = options.runner ?? createGitCommandRunner();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const createTemporaryDirectory =
    options.createTemporaryDirectory ?? (() => mkdtemp(join(tmpdir(), 'zapp-github-import-')));
  const removeTemporaryDirectory =
    options.removeTemporaryDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));

  return {
    async mirror(rawInput) {
      const input = MirrorInputSchema.parse(rawInput);
      const directory = await createTemporaryDirectory();
      const repository = join(directory, 'repository');
      const sourceAskpass = join(directory, 'source-askpass.sh');
      const targetAskpass = join(directory, 'target-askpass.sh');
      try {
        await Promise.all([
          writeFile(sourceAskpass, ASKPASS, { mode: 0o700 }),
          writeFile(targetAskpass, ASKPASS, { mode: 0o700 }),
        ]);
        await Promise.all([chmod(sourceAskpass, 0o700), chmod(targetAskpass, 0o700)]);
        const baseEnv = {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        } as const;
        const sourceEnv = {
          ...baseEnv,
          GIT_ASKPASS: sourceAskpass,
          ZAPP_GIT_USERNAME: 'x-access-token',
          ZAPP_GIT_PASSWORD: input.sourceToken,
        };
        const targetEnv = {
          ...baseEnv,
          GIT_ASKPASS: targetAskpass,
          ZAPP_GIT_USERNAME: input.targetUsername,
          ZAPP_GIT_PASSWORD: input.targetToken,
        };

        await runner.run({
          args: [
            'clone',
            '--no-tags',
            '--single-branch',
            '--branch',
            input.sourceBranch,
            '--origin',
            'source',
            '--',
            input.sourceCloneUrl,
            repository,
          ],
          env: sourceEnv,
          timeoutMs,
        });
        const resolved = await runner.run({
          args: ['rev-parse', 'HEAD'],
          cwd: repository,
          env: baseEnv,
          timeoutMs,
        });
        const headCommitSha = CommitShaSchema.parse(resolved.stdout.trim());
        await runner.run({
          args: ['remote', 'add', 'target', input.targetCloneUrl],
          cwd: repository,
          env: baseEnv,
          timeoutMs,
        });
        const remote = await runner.run({
          args: ['ls-remote', 'target'],
          cwd: repository,
          env: targetEnv,
          timeoutMs,
        });
        const target = targetState(remote.stdout, input.sourceBranch, headCommitSha);
        if (target === 'conflict') {
          throw new GitMirrorConflictError();
        }
        if (target === 'empty') {
          await runner.run({
            args: ['push', 'target', `HEAD:refs/heads/${input.sourceBranch}`],
            cwd: repository,
            env: targetEnv,
            timeoutMs,
          });
        }
        return { headCommitSha };
      } catch (error) {
        if (error instanceof GitMirrorConflictError) throw error;
        throw new GitMirrorError();
      } finally {
        await removeTemporaryDirectory(directory);
      }
    },
  };
}
