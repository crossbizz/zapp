import { readFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

import type { BackupGit } from './backup.js';
import type { TokenService } from './tokens.js';

const MAX_GIT_BUNDLE_BYTES = 128 * 1024 * 1024;

const GitBundleExportInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    operationKey: z.string().min(8).max(255),
  })
  .strict();

export interface GitBundleCredentialPort {
  mintRead(input: {
    readonly organizationId: string;
    readonly projectId: string;
  }): Promise<{
    readonly username: string;
    readonly token: string;
    readonly cloneUrl: string;
  }>;
  revoke(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly username: string;
  }): Promise<void>;
}

export interface GitBundleExporter {
  bundle(input: z.input<typeof GitBundleExportInputSchema>): Promise<Buffer>;
}

export function createGitBundleExporter(options: {
  readonly credentials: GitBundleCredentialPort;
  readonly commands: (credential: {
    readonly username: string;
    readonly token: string;
  }) => BackupGit;
}): GitBundleExporter {
  return {
    async bundle(rawInput) {
      const input = GitBundleExportInputSchema.parse(rawInput);
      const directory = await mkdtemp(join(tmpdir(), 'zapp-project-export-'));
      const bundlePath = join(directory, 'repository.bundle');
      let credential:
        | { readonly username: string; readonly token: string; readonly cloneUrl: string }
        | undefined;
      let bundle: Buffer | undefined;
      let failure: Error | undefined;
      try {
        credential = await options.credentials.mintRead(input);
        const commands = options.commands({
          username: z.string().min(1).parse(credential.username),
          token: z.string().min(1).parse(credential.token),
        });
        const cloneUrl = z
          .string()
          .url()
          .refine((value) => /^https?:\/\//u.test(value))
          .parse(credential.cloneUrl);
        await commands.createBundle(cloneUrl, bundlePath);
        const details = await stat(bundlePath);
        if (!details.isFile() || details.size === 0 || details.size > MAX_GIT_BUNDLE_BYTES) {
          throw new Error('Git bundle export size is invalid');
        }
        await commands.verifyBundle(bundlePath);
        bundle = await readFile(bundlePath);
      } catch {
        failure = new Error('Git bundle export failed');
      }

      let cleanupFailed = false;
      if (credential !== undefined) {
        try {
          await options.credentials.revoke({
            organizationId: input.organizationId,
            projectId: input.projectId,
            username: credential.username,
          });
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) throw new Error('Git bundle export cleanup failed');
      if (failure !== undefined) throw failure;
      if (bundle === undefined) throw new Error('Git bundle export failed');
      return bundle;
    },
  };
}

export function createTokenServiceGitBundleCredentials(
  tokens: TokenService,
): GitBundleCredentialPort {
  return {
    async mintRead(input) {
      const minted = await tokens.mint({
        organizationId: input.organizationId,
        projectId: input.projectId,
        access: 'read',
        ttlSec: 600,
        requestingService: 'control-api',
      });
      return { username: minted.username, token: minted.token, cloneUrl: minted.cloneUrl };
    },
    async revoke(input) {
      await tokens.revokeEphemeral({
        organizationId: input.organizationId,
        projectId: input.projectId,
        username: input.username,
        requestingService: 'control-api',
      });
    },
  };
}
