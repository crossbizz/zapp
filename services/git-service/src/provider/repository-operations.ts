import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovedTemplateSourceSchema } from '@zapp/config/templates';
import { CommitShaSchema, InternalRepoRefSchema } from '@zapp/contracts';
import { z } from 'zod';

import {
  GitCommandExecutionError,
  createGitCommandRunner,
  type GitCommandRunner,
} from '../import/git.js';

export const MAX_COMMIT_PATCH_BYTES = 512 * 1024;

const RepositoryCredentialSchema = z
  .object({
    cloneUrl: z.string().trim().min(1).max(2_048),
    username: z.string().min(1).max(255),
    credential: z.string().min(1).max(4_096),
  })
  .strict();

export const CompareCommitsInputSchema = z
  .object({
    repository: RepositoryCredentialSchema,
    beforeSha: CommitShaSchema,
    afterSha: CommitShaSchema,
  })
  .strict();

export const SeedRepositoryInputSchema = z
  .object({
    source: RepositoryCredentialSchema,
    target: RepositoryCredentialSchema,
    sourceCommitSha: CommitShaSchema,
    sourceIdentity: ApprovedTemplateSourceSchema.shape.repoRef,
    targetIdentity: InternalRepoRefSchema,
    operationKey: z
      .string()
      .min(8)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  })
  .strict();

export type RepositoryCredential = z.infer<typeof RepositoryCredentialSchema>;
export type CompareCommitsInput = z.infer<typeof CompareCommitsInputSchema>;
export type SeedRepositoryInput = z.infer<typeof SeedRepositoryInputSchema>;

export interface CommitComparison {
  readonly beforeSha: string;
  readonly afterSha: string;
  readonly patch: string;
}

export interface RepositorySeedResult {
  readonly headCommitSha: string;
  readonly replayed: boolean;
}

export interface RepositoryOperations {
  compare(input: z.input<typeof CompareCommitsInputSchema>): Promise<CommitComparison>;
  seed(input: z.input<typeof SeedRepositoryInputSchema>): Promise<RepositorySeedResult>;
}

export class CommitComparisonTooLargeError extends Error {
  constructor() {
    super('commit comparison exceeds the response limit');
    this.name = 'CommitComparisonTooLargeError';
  }
}

export class CommitComparisonNotFoundError extends Error {
  constructor() {
    super('one or both comparison commits are not in the repository');
    this.name = 'CommitComparisonNotFoundError';
  }
}

export class RepositorySeedConflictError extends Error {
  constructor() {
    super('target repository already contains different history or a different seed receipt');
    this.name = 'RepositorySeedConflictError';
  }
}

export class RepositoryOperationError extends Error {
  constructor() {
    super('repository operation failed');
    this.name = 'RepositoryOperationError';
  }
}

interface RepositoryOperationsOptions {
  readonly maxPatchBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly runner?: GitCommandRunner;
  readonly patchRunner?: GitCommandRunner;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$ZAPP_GIT_USERNAME" ;;
  *) printf '%s\\n' "$ZAPP_GIT_PASSWORD" ;;
esac
`;

function receiptRef(input: SeedRepositoryInput): string {
  const identity = JSON.stringify({
    version: 1,
    operationKey: input.operationKey,
    sourceIdentity: input.sourceIdentity,
    sourceCommitSha: input.sourceCommitSha,
    targetIdentity: input.targetIdentity,
  });
  const digest = createHash('sha256').update(identity).digest('hex');
  return `refs/zapp/template-seeds/${digest}`;
}

function parseRemoteRefs(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  if (stdout.trim() === '') return refs;
  for (const line of stdout.trim().split('\n')) {
    const [sha, ref, ...extra] = line.trim().split(/\s+/u);
    if (extra.length !== 0 || sha === undefined || ref === undefined) {
      throw new RepositoryOperationError();
    }
    refs.set(ref, CommitShaSchema.parse(sha));
  }
  return refs;
}

function credentialEnv(askpass: string, credential: RepositoryCredential) {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpass,
    GIT_ASKPASS_REQUIRE: 'force',
    ZAPP_GIT_USERNAME: credential.username,
    ZAPP_GIT_PASSWORD: credential.credential,
  } as const;
}

const LOCAL_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
} as const;

export function createRepositoryOperations(
  options: RepositoryOperationsOptions = {},
): RepositoryOperations {
  const maxPatchBytes = options.maxPatchBytes ?? MAX_COMMIT_PATCH_BYTES;
  if (!Number.isInteger(maxPatchBytes) || maxPatchBytes <= 0) {
    throw new Error('maxPatchBytes must be a positive integer');
  }
  const timeoutMs = options.commandTimeoutMs ?? 60_000;
  const runner = options.runner ?? createGitCommandRunner();
  const patchRunner = options.patchRunner ?? createGitCommandRunner(maxPatchBytes);
  const createTemporaryDirectory =
    options.createTemporaryDirectory ??
    (() => mkdtemp(join(tmpdir(), 'zapp-repository-operation-')));
  const removeTemporaryDirectory =
    options.removeTemporaryDirectory ??
    ((directory: string) => rm(directory, { recursive: true, force: true }));

  async function askpass(directory: string, name: string): Promise<string> {
    const path = join(directory, `${name}-askpass.sh`);
    await writeFile(path, ASKPASS, { mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  }

  return {
    async compare(rawInput) {
      const input = CompareCommitsInputSchema.parse(rawInput);
      const directory = await createTemporaryDirectory();
      const repository = join(directory, 'repository.git');
      try {
        const repositoryAskpass = await askpass(directory, 'repository');
        await runner.run({
          args: [
            'clone',
            '--bare',
            '--no-tags',
            '--quiet',
            '--',
            input.repository.cloneUrl,
            repository,
          ],
          env: credentialEnv(repositoryAskpass, input.repository),
          timeoutMs,
        });
        try {
          await Promise.all(
            [input.beforeSha, input.afterSha].map((sha) =>
              runner.run({
                args: ['cat-file', '-e', `${sha}^{commit}`],
                cwd: repository,
                env: LOCAL_GIT_ENV,
                timeoutMs,
              }),
            ),
          );
        } catch {
          throw new CommitComparisonNotFoundError();
        }

        let patch: string;
        try {
          patch = (
            await patchRunner.run({
              args: [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--no-renames',
                '--full-index',
                input.beforeSha,
                input.afterSha,
                '--',
              ],
              cwd: repository,
              env: LOCAL_GIT_ENV,
              timeoutMs,
            })
          ).stdout;
        } catch (error) {
          if (error instanceof GitCommandExecutionError && error.kind === 'output_limit') {
            throw new CommitComparisonTooLargeError();
          }
          throw error;
        }
        if (Buffer.byteLength(patch) > maxPatchBytes) {
          throw new CommitComparisonTooLargeError();
        }
        return { beforeSha: input.beforeSha, afterSha: input.afterSha, patch };
      } catch (error) {
        if (
          error instanceof CommitComparisonTooLargeError ||
          error instanceof CommitComparisonNotFoundError
        ) {
          throw error;
        }
        throw new RepositoryOperationError();
      } finally {
        await removeTemporaryDirectory(directory);
      }
    },

    async seed(rawInput) {
      const input = SeedRepositoryInputSchema.parse(rawInput);
      const directory = await createTemporaryDirectory();
      const repository = join(directory, 'source.git');
      const requestedReceipt = receiptRef(input);
      try {
        const [sourceAskpass, targetAskpass] = await Promise.all([
          askpass(directory, 'source'),
          askpass(directory, 'target'),
        ]);
        await runner.run({
          args: [
            'clone',
            '--bare',
            '--no-tags',
            '--quiet',
            '--',
            input.source.cloneUrl,
            repository,
          ],
          env: credentialEnv(sourceAskpass, input.source),
          timeoutMs,
        });
        try {
          await runner.run({
            args: ['cat-file', '-e', `${input.sourceCommitSha}^{commit}`],
            cwd: repository,
            env: LOCAL_GIT_ENV,
            timeoutMs,
          });
        } catch {
          throw new RepositoryOperationError();
        }
        await runner.run({
          args: ['remote', 'add', 'target', input.target.cloneUrl],
          cwd: repository,
          env: LOCAL_GIT_ENV,
          timeoutMs,
        });
        const targetEnv = credentialEnv(targetAskpass, input.target);
        const before = parseRemoteRefs(
          (
            await runner.run({
              args: ['ls-remote', '--refs', 'target'],
              cwd: repository,
              env: targetEnv,
              timeoutMs,
            })
          ).stdout,
        );
        const mainRef = 'refs/heads/main';
        const seedReceipts = [...before.keys()].filter((ref) =>
          ref.startsWith('refs/zapp/template-seeds/'),
        );
        let replayed = false;
        if (before.size === 0) {
          await runner.run({
            args: [
              'push',
              '--atomic',
              '--porcelain',
              'target',
              `${input.sourceCommitSha}:${mainRef}`,
              `${input.sourceCommitSha}:${requestedReceipt}`,
            ],
            cwd: repository,
            env: targetEnv,
            timeoutMs,
          });
        } else if (
          before.get(mainRef) === input.sourceCommitSha &&
          before.get(requestedReceipt) === input.sourceCommitSha &&
          seedReceipts.length === 1
        ) {
          replayed = true;
        } else {
          throw new RepositorySeedConflictError();
        }

        const after = parseRemoteRefs(
          (
            await runner.run({
              args: ['ls-remote', '--refs', 'target', mainRef, requestedReceipt],
              cwd: repository,
              env: targetEnv,
              timeoutMs,
            })
          ).stdout,
        );
        if (
          after.get(mainRef) !== input.sourceCommitSha ||
          after.get(requestedReceipt) !== input.sourceCommitSha
        ) {
          throw new RepositoryOperationError();
        }
        return { headCommitSha: input.sourceCommitSha, replayed };
      } catch (error) {
        if (error instanceof RepositorySeedConflictError) throw error;
        throw new RepositoryOperationError();
      } finally {
        await removeTemporaryDirectory(directory);
      }
    },
  };
}
