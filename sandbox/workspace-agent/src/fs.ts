import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { z } from 'zod';
import { resolveInRoot } from '@zapp/workspace-runtime';

export const FileQuerySchema = z.object({ path: z.string().min(1) }).strict();
export const ListQuerySchema = z
  .object({
    path: z.string().min(1).default('.'),
    glob: z.string().min(1).optional(),
    maxDepth: z.coerce.number().int().min(0).max(100).optional(),
  })
  .strict();

export const FileEntrySchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'symlink']),
  })
  .strict();
export const FileListSchema = z.array(FileEntrySchema);
export const BinaryBodySchema = z.instanceof(Buffer);

export type ListQuery = z.infer<typeof ListQuerySchema>;
export type FileEntry = z.infer<typeof FileEntrySchema>;

function globMatches(path: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'u').test(basename(path));
}

export async function readWorkspaceFile(root: string, path: string): Promise<Buffer> {
  return readFile(await resolveInRoot(root, path));
}

export async function writeWorkspaceFile(root: string, path: string, body: Buffer): Promise<void> {
  await writeFile(await resolveInRoot(root, path), body);
}

export async function listWorkspaceFiles(root: string, query: ListQuery): Promise<FileEntry[]> {
  const directory = await resolveInRoot(root, query.path);
  const maxDepth = query.maxDepth ?? Number.POSITIVE_INFINITY;
  const files: FileEntry[] = [];

  const visit = async (current: string, depth: number): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = await resolveInRoot(root, relative(root, resolve(current, entry.name)));
      const path = relative(directory, child);
      const type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file';
      if (query.glob === undefined || globMatches(path, query.glob)) {
        files.push(FileEntrySchema.parse({ path, type }));
      }
      if (entry.isDirectory() && depth < maxDepth) {
        await visit(child, depth + 1);
      }
    }
  };

  await visit(directory, 0);
  return FileListSchema.parse(files.sort((left, right) => left.path.localeCompare(right.path)));
}
