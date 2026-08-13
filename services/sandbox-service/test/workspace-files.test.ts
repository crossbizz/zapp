import { describe, expect, it } from 'vitest';

import {
  MAX_EDITOR_FILE_BYTES,
  createWorkspaceFileEditor,
  type WorkspaceFileEditorProvider,
} from '../src/workspace-files.js';

const WORKSPACE_ID = 'provider-workspace-1';
const OPERATION_KEY = `op_${'a'.repeat(64)}`;

class FakeProvider implements WorkspaceFileEditorProvider {
  readonly files = new Map([['src/index.ts', Buffer.from('before\n')]]);
  readonly gitInputs: unknown[] = [];
  readonly writes: Array<{ path: string; body: string; key: string | undefined }> = [];
  failCommit = false;

  readFile(_workspaceId: string, path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) return Promise.reject(new Error('missing'));
    return Promise.resolve(value);
  }

  listFiles() {
    return Promise.resolve(
      Array.from({ length: 501 }, (_, index) => ({
        path: `src/file-${String(index)}.ts`,
        type: 'file' as const,
      })),
    );
  }

  writeFilesAtomically(
    _workspaceId: string,
    files: readonly { path: string; data: Uint8Array }[],
    key?: string,
  ): Promise<void> {
    for (const file of files) {
      const body = Buffer.from(file.data);
      this.files.set(file.path, body);
      this.writes.push({ path: file.path, body: body.toString('utf8'), key });
    }
    return Promise.resolve();
  }

  git(_workspaceId: string, input: unknown) {
    this.gitInputs.push(input);
    const operation = (input as { operation: string }).operation;
    if (operation === 'add_commit' && this.failCommit) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'commit failed' });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: operation === 'add_commit' ? '[main abcdef012345] manual edit via web\n' : '',
      stderr: '',
    });
  }
}

describe('WS-16 workspace file editor boundary', () => {
  it('returns bounded lazy listings and bounded reads with a stable compare token', async () => {
    const provider = new FakeProvider();
    const editor = createWorkspaceFileEditor(provider);

    const listing = await editor.list(WORKSPACE_ID, 'src', { maxDepth: 1 });
    const read = await editor.read(WORKSPACE_ID, 'src/index.ts');

    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(true);
    expect(read).toMatchObject({
      path: 'src/index.ts',
      dataBase64: Buffer.from('before\n').toString('base64'),
      byteSize: 7,
    });
    expect(read.compareToken).toMatch(/^[0-9a-f]{64}$/u);
    provider.files.set('src/large.bin', Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1));
    await expect(editor.read(WORKSPACE_ID, 'src/large.bin')).rejects.toMatchObject({
      code: 'workspace_file_too_large',
    });
  });

  it('rejects stale and unsafe edits, then creates exactly one attributed manual commit', async () => {
    const provider = new FakeProvider();
    const editor = createWorkspaceFileEditor(provider);
    const snapshot = await editor.read(WORKSPACE_ID, 'src/index.ts');

    await expect(
      editor.edit(WORKSPACE_ID, {
        path: '../outside', data: Buffer.from('bad'), expectedCompareToken: snapshot.compareToken,
        actorUserId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NY', operationKey: OPERATION_KEY,
      }),
    ).rejects.toMatchObject({ code: 'workspace_path_invalid' });
    await expect(
      editor.edit(WORKSPACE_ID, {
        path: 'src/index.ts', data: Buffer.from('bad'), expectedCompareToken: '0'.repeat(64),
        actorUserId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NY', operationKey: OPERATION_KEY,
      }),
    ).rejects.toMatchObject({ code: 'workspace_edit_stale' });

    const edited = await editor.edit(WORKSPACE_ID, {
      path: 'src/index.ts', data: Buffer.from('after\n'),
      expectedCompareToken: snapshot.compareToken,
      actorUserId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NY', operationKey: OPERATION_KEY,
    });

    expect(edited).toMatchObject({ path: 'src/index.ts', commitRef: 'abcdef012345' });
    expect(provider.files.get('src/index.ts')?.toString('utf8')).toBe('after\n');
    expect(provider.gitInputs).toEqual([{ operation: 'add_commit', paths: ['src/index.ts'], message: 'manual edit via web' }]);
    expect(provider.writes).toHaveLength(1);
  });

  it('restores original bytes and the staged path when commit creation fails', async () => {
    const provider = new FakeProvider();
    provider.failCommit = true;
    const editor = createWorkspaceFileEditor(provider);
    const snapshot = await editor.read(WORKSPACE_ID, 'src/index.ts');

    await expect(
      editor.edit(WORKSPACE_ID, {
        path: 'src/index.ts', data: Buffer.from('after\n'),
        expectedCompareToken: snapshot.compareToken,
        actorUserId: 'user_01J8ME7YQZJ2V9Q0X3T5B6K7NY', operationKey: OPERATION_KEY,
      }),
    ).rejects.toMatchObject({ code: 'workspace_edit_commit_failed' });

    expect(provider.files.get('src/index.ts')?.toString('utf8')).toBe('before\n');
    expect(provider.gitInputs).toEqual([
      { operation: 'add_commit', paths: ['src/index.ts'], message: 'manual edit via web' },
      { operation: 'restore', args: ['--staged', '--', 'src/index.ts'] },
    ]);
    expect(provider.writes.map(({ body }) => body)).toEqual(['after\n', 'before\n']);
  });
});
