import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_EDITOR_FILE_BYTES = 1_048_576;
export const MAX_EDITOR_LIST_ENTRIES = 500;
export const MANUAL_EDIT_COMMIT_SUBJECT = 'manual edit via web';

type FileEntry = { readonly path: string; readonly type: 'file' | 'directory' | 'symlink' };
type GitResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

export interface WorkspaceFileEditorProvider {
  readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array>;
  listFiles(
    providerWorkspaceId: string,
    path: string,
    options?: { readonly glob?: string; readonly maxDepth?: number },
  ): Promise<readonly FileEntry[]>;
  writeFilesAtomically(
    providerWorkspaceId: string,
    files: readonly {
      readonly path: string;
      readonly data: Uint8Array;
      readonly expectedRevision?: string;
    }[],
    idempotencyKey?: string,
  ): Promise<void>;
  git(providerWorkspaceId: string, input: unknown, idempotencyKey?: string): Promise<GitResult>;
}

export class WorkspaceFileBoundaryError extends Error {
  constructor(
    readonly code:
      | 'workspace_path_invalid'
      | 'workspace_file_too_large'
      | 'workspace_edit_stale'
      | 'workspace_edit_commit_failed'
      | 'workspace_edit_rollback_failed'
      | 'workspace_edit_idempotency_conflict',
    readonly statusCode: 400 | 409 | 413 | 502,
  ) {
    super(code);
    this.name = 'WorkspaceFileBoundaryError';
  }
}

export interface WorkspaceDirectEditInput {
  readonly path: string;
  readonly data: Uint8Array;
  readonly expectedCompareToken: string;
  readonly actorUserId: string;
  readonly operationKey: string;
}

function validatePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').some((part) => part === '..')
  ) {
    throw new WorkspaceFileBoundaryError('workspace_path_invalid', 400);
  }
  return path;
}

function compareToken(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function tokensEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requireBounded(data: Uint8Array): Buffer {
  if (data.byteLength > MAX_EDITOR_FILE_BYTES) {
    throw new WorkspaceFileBoundaryError('workspace_file_too_large', 413);
  }
  return Buffer.from(data);
}

function parseCommitRef(stdout: string): string {
  const match = /(?:^|\s)([0-9a-f]{7,64})(?=\s|\])/u.exec(stdout);
  if (match?.[1] === undefined) {
    throw new WorkspaceFileBoundaryError('workspace_edit_commit_failed', 502);
  }
  return match[1];
}

export function createWorkspaceFileEditor(provider: WorkspaceFileEditorProvider) {
  const tails = new Map<string, Promise<void>>();
  const completed = new Map<
    string,
    { readonly fingerprint: string; readonly result: { path: string; commitRef: string; compareToken: string } }
  >();

  async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  return {
    async list(
      providerWorkspaceId: string,
      path: string,
      options?: { readonly glob?: string; readonly maxDepth?: number },
    ) {
      const entries = await provider.listFiles(providerWorkspaceId, validatePath(path), options);
      return {
        entries: entries.slice(0, MAX_EDITOR_LIST_ENTRIES),
        truncated: entries.length > MAX_EDITOR_LIST_ENTRIES,
      };
    },

    async read(providerWorkspaceId: string, path: string) {
      const validatedPath = validatePath(path);
      const data = requireBounded(await provider.readFile(providerWorkspaceId, validatedPath));
      return {
        path: validatedPath,
        dataBase64: data.toString('base64'),
        byteSize: data.byteLength,
        compareToken: compareToken(data),
      };
    },

    async edit(providerWorkspaceId: string, input: WorkspaceDirectEditInput) {
      const path = validatePath(input.path);
      const next = requireBounded(input.data);
      const nextToken = compareToken(next);
      const fingerprint = compareToken(Buffer.from(JSON.stringify({
        path,
        expectedCompareToken: input.expectedCompareToken,
        nextToken,
        actorUserId: input.actorUserId,
      })));
      const replayKey = `${providerWorkspaceId}:${input.operationKey}`;

      return serialized(providerWorkspaceId, async () => {
        const replay = completed.get(replayKey);
        if (replay !== undefined) {
          if (replay.fingerprint !== fingerprint) {
            throw new WorkspaceFileBoundaryError('workspace_edit_idempotency_conflict', 409);
          }
          return replay.result;
        }

        const before = requireBounded(await provider.readFile(providerWorkspaceId, path));
        if (!tokensEqual(compareToken(before), input.expectedCompareToken)) {
          throw new WorkspaceFileBoundaryError('workspace_edit_stale', 409);
        }

        await provider.writeFilesAtomically(
          providerWorkspaceId,
          [{ path, data: next }],
          `${input.operationKey}:write`,
        );
        const committed = await provider.git(
          providerWorkspaceId,
          { operation: 'add_commit', paths: [path], message: MANUAL_EDIT_COMMIT_SUBJECT },
          `${input.operationKey}:commit`,
        );
        if (committed.exitCode !== 0) {
          let rollbackFailed = false;
          try {
            const restoredIndex = await provider.git(
              providerWorkspaceId,
              { operation: 'restore', args: ['--staged', '--', path] },
              `${input.operationKey}:rollback-index`,
            );
            rollbackFailed = restoredIndex.exitCode !== 0;
          } catch {
            rollbackFailed = true;
          }
          try {
            await provider.writeFilesAtomically(
              providerWorkspaceId,
              [{ path, data: before }],
              `${input.operationKey}:rollback-file`,
            );
          } catch {
            rollbackFailed = true;
          }
          throw new WorkspaceFileBoundaryError(
            rollbackFailed ? 'workspace_edit_rollback_failed' : 'workspace_edit_commit_failed',
            502,
          );
        }

        const result = { path, commitRef: parseCommitRef(committed.stdout), compareToken: nextToken };
        completed.set(replayKey, { fingerprint, result });
        if (completed.size > 1_000) completed.delete(completed.keys().next().value as string);
        return result;
      });
    },
  };
}
